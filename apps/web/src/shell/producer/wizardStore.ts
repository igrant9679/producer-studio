// Wizard state lives in a module store so long-running steps (uploads, transcription, script, assembly)
// keep going across route changes/remounts. Every change is mirrored to sessionStorage per project, and the brief and
// script are saved to the project itself (ai.brief, ai.script) as they're typed, so another tab or device resumes them.
import type { AssetRecord, Job } from '@producer/core'
import { create } from 'zustand'
import { api, HttpError, waitForJob } from '../../lib/api'
import { useJobs, waitForAssetReady } from '../stores'
import { aspectFor, ssSet } from '../util'
import { draftKey, isIdea, readyAssetIds, storageKey, type WizardAsset, type WizardState, initialState } from './wizardLogic'

interface WizardStore {
  s: WizardState
  patch: (p: Partial<WizardState> | ((s: WizardState) => Partial<WizardState>)) => void
  replace: (s: WizardState) => void
}

export const useWizard = create<WizardStore>((set) => ({
  s: initialState(),
  patch: (p) => set((st) => ({ s: { ...st.s, ...(typeof p === 'function' ? p(st.s) : p) } })),
  replace: (s) => {
    epoch++
    set({ s })
  },
}))

// Bumped whenever a different wizard session is loaded, so stale async work can't write into it.
let epoch = 0

useWizard.subscribe((st, prev) => {
  if (st.s === prev.s) return
  // Persist (drop in-flight progress noise is fine — it is small).
  ssSet(storageKey(st.s.projectId), st.s)
  const s = st.s
  const p = prev.s
  // an edit to the brief or script of this project: save it to the project shortly
  if (s.projectId && s.projectId === p.projectId && (s.brief !== p.brief || s.scenes !== p.scenes || s.scriptBrief !== p.scriptBrief) && canSaveDraft(s)) {
    // what a job just wrote to the project (or an edit undone) needs no save
    const held = savedDrafts.get(s.projectId) === draftKey(s)
    const state = held ? 'saved' : 'pending'
    if (s.draft?.state !== state) useWizard.getState().patch({ draft: { state } })
    if (!held) scheduleDraftSave()
  }
})

type Patch = Partial<WizardState> | ((s: WizardState) => Partial<WizardState>)
const get = () => useWizard.getState().s
/** A patch function bound to the current session; becomes a no-op once another session is loaded. */
function scoped() {
  const ep = epoch
  const live = () => ep === epoch
  const patch = (p: Patch) => {
    if (live()) useWizard.getState().patch(p)
  }
  const patchAsset = (localId: string, p: Partial<WizardAsset>) => patch((s) => ({ assets: s.assets.map((a) => (a.localId === localId ? { ...a, ...p } : a)) }))
  return { patch, patchAsset, live }
}
const patch = (p: Patch) => useWizard.getState().patch(p)

let n = 0
let abort: AbortController | undefined

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.body?.error || e.message
  return e instanceof Error ? e.message : String(e)
}

function trackJob(j: Job) {
  useJobs.getState().upsert(j)
}

// ---------------- draft: the brief and script, saved to the project as they're typed ----------------

/** What each project holds (draftKey), so only real edits are sent. */
const savedDrafts = new Map<string, string>()
let draftTimer: ReturnType<typeof setTimeout> | undefined
let draftSaving = false

/** The project already holds this state's brief and script (it was loaded from there, or a job just wrote them). */
export function markDraftSaved(s: WizardState) {
  if (s.projectId) savedDrafts.set(s.projectId, draftKey(s))
}

// the editor autosaves on the same beat
function scheduleDraftSave(ms = 1200) {
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => void saveDraft(), ms)
}

/** While a job runs, or the Write step is replacing the script, the job owns it: edits are saved once it's done. */
function canSaveDraft(s: WizardState): boolean {
  return !!s.projectId && s.run.status !== 'running' && s.step !== 'generate'
}

/** Save the brief and script to the project now (the debounce and "Retry" both land here). */
export async function saveDraft(): Promise<void> {
  const s = get()
  if (!canSaveDraft(s)) return
  const { patch, live } = scoped()
  const key = draftKey(s)
  if (savedDrafts.get(s.projectId!) === key) {
    if (s.draft?.state !== 'saved') patch({ draft: { state: 'saved' } })
    return
  }
  // one save at a time, so an older one can never land after a newer one
  if (draftSaving) return scheduleDraftSave()
  draftSaving = true
  patch({ draft: { state: 'saving' } })
  try {
    await api.saveProducerDraft({ projectId: s.projectId!, brief: s.brief, scenes: s.scenes, ...(s.scriptBrief ? { scriptBrief: s.scriptBrief } : {}) })
    savedDrafts.set(s.projectId!, key)
    patch({ draft: { state: draftKey(get()) === key ? 'saved' : 'pending' } })
  } catch (e) {
    patch({ draft: { state: 'error', error: errMsg(e) } })
  } finally {
    draftSaving = false
  }
  // typed more while it was saving
  if (live() && get().draft?.state === 'pending') scheduleDraftSave(0)
}

/**
 * After a reload with this tab's copy: send edits that weren't saved yet; otherwise take the project's brief and script
 * (another tab or device may have edited them since).
 */
export async function resumeDraft() {
  const s = get()
  if (!s.projectId) return
  const { patch, live } = scoped()
  // a copy from before drafts were saved to the project holds edits the project never got
  if (!s.draft || s.draft.state !== 'saved') {
    if (canSaveDraft(s)) scheduleDraftSave(0)
    return
  }
  markDraftSaved(s)
  const res = await api.project(s.projectId).catch(() => undefined)
  const ai = res?.project.ai
  const cur = get()
  if (!live() || !ai?.script?.scenes || cur.draft?.state !== 'saved' || cur.run.status === 'running') return
  const next = { brief: ai.brief ?? cur.brief, scenes: ai.script.scenes, scriptBrief: ai.script.brief ?? cur.scriptBrief }
  if (draftKey(next) === draftKey(cur)) return
  markDraftSaved({ ...cur, ...next })
  patch(next)
}

// ---------------- uploads ----------------

/** Uploads go to the wizard's own space (`workspaceId`); the first one binds a new draft to it. */
export async function uploadToWizard(workspaceId: string, files: File[]) {
  const { patch, patchAsset } = scoped()
  const items: Array<{ file: File; localId: string }> = files.map((file) => ({ file, localId: `l${Date.now().toString(36)}${++n}` }))
  patch((s) => ({ ...(s.workspaceId ? {} : { workspaceId }), assets: [...s.assets, ...items.map(({ file, localId }) => ({ localId, name: file.name, size: file.size, status: 'uploading' as const, progress: 0 }))] }))
  await Promise.all(
    items.map(async ({ file, localId }) => {
      try {
        const rec = await api.upload(workspaceId, file, (f) => patchAsset(localId, { progress: f }))
        patchAsset(localId, { assetId: rec.asset.id, status: rec.status === 'ready' ? 'ready' : 'processing', progress: 1, duration: rec.asset.duration, hasAudio: rec.asset.hasAudio })
        if (rec.status !== 'ready') await waitAsset(localId, rec.asset.id)
      } catch (e) {
        patchAsset(localId, { status: 'error', error: errMsg(e) })
      }
    }),
  )
}

async function waitAsset(localId: string, assetId: string) {
  const { patchAsset } = scoped()
  try {
    const ready = await waitForAssetReady(assetId)
    patchAsset(localId, { status: 'ready', duration: ready.asset.duration, hasAudio: ready.asset.hasAudio, name: ready.asset.name })
  } catch (e) {
    patchAsset(localId, { status: 'error', error: errMsg(e) })
  }
}

/** After a refresh: keep waiting on assets that were still processing. */
export function resumeProcessingAssets() {
  for (const a of get().assets) if (a.status === 'processing' && a.assetId) void waitAsset(a.localId, a.assetId)
}

/** Recordings picked from the library of `workspaceId` (the wizard's own space). */
export function addLibraryAssets(recs: AssetRecord[], workspaceId?: string) {
  patch((s) => {
    const have = new Set(s.assets.map((a) => a.assetId))
    const add = recs
      .filter((r) => !have.has(r.asset.id))
      .map((r) => ({ localId: r.asset.id, assetId: r.asset.id, name: r.asset.name, size: r.asset.sizeBytes ?? 0, status: r.status === 'ready' ? ('ready' as const) : r.status === 'error' ? ('error' as const) : ('processing' as const), progress: 1, duration: r.asset.duration, hasAudio: r.asset.hasAudio }))
    return { ...(s.workspaceId || !workspaceId ? {} : { workspaceId }), assets: [...s.assets, ...add] }
  })
  for (const r of recs) if (r.status !== 'ready' && r.status !== 'error') void waitAsset(r.asset.id, r.asset.id)
}

export function removeWizardAsset(localId: string) {
  patch((s) => ({ assets: s.assets.filter((a) => a.localId !== localId) }))
}

// ---------------- runs ----------------

async function runJob<R>(patch: (p: Patch) => void, start: () => Promise<Job<R>>, onUpdate: (j: Job<R>) => void, existingJobId?: string): Promise<Job<R>> {
  const id = existingJobId ?? (await start()).id
  patch((s) => ({ run: { ...s.run, jobId: id } }))
  const signal = abort?.signal
  const j = await waitForJob<R>(id, (u) => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    trackJob(u as Job)
    onUpdate(u)
  })
  patch((s) => ({ run: { ...s.run, jobId: undefined } }))
  return j
}

/** Create project (if needed) → transcribe each asset → write the script. Resumable. */
export async function runGenerate(workspaceId: string, onProjectCreated?: (id: string) => void) {
  abort?.abort()
  abort = new AbortController()
  const signal = abort.signal
  const { patch } = scoped()
  const resumeJob = get().run.interrupted ? get().run.jobId : undefined
  const resumePhase = get().run.phase
  patch({ step: 'generate', run: { status: 'running', phase: 'create', message: 'Setting up your project…', progress: -1 } })
  try {
    let s = get()
    if (!s.projectId) {
      const { brief } = s
      const res = await api.createProject({ workspaceId, name: brief.title || 'Producer project', kind: 'producer', ...aspectFor(brief.aspect) })
      // Move the draft over to the project's storage key.
      ssSet(storageKey(undefined), undefined)
      patch({ projectId: res.summary.id, workspaceId })
      onProjectCreated?.(res.summary.id)
    }
    s = get()
    // from an idea there's nothing to transcribe: straight to the script
    const ids = isIdea(s) ? [] : readyAssetIds(s)
    // a recording with no sound is footage only: there's nothing to transcribe (the script step skips it too)
    const silent = ids.filter((id) => !s.transcribed.includes(id) && s.assets.find((a) => a.assetId === id)?.hasAudio === false)
    if (silent.length) patch((st) => ({ transcribed: [...st.transcribed, ...silent] }))
    const todo = ids.filter((id) => !s.transcribed.includes(id) && !silent.includes(id))
    for (let i = 0; i < todo.length; i++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      const id = todo[i]
      const name = s.assets.find((a) => a.assetId === id)?.name ?? 'recording'
      const label = todo.length > 1 ? `Transcribing ${name} (${i + 1} of ${todo.length})` : `Transcribing ${name}`
      patch({ run: { status: 'running', phase: 'transcribe', message: `${label}…`, progress: 0 } })
      await runJob(
        patch,
        () => api.transcribe(id),
        (j) => patch((st) => ({ run: { ...st.run, message: j.message ? `${label} — ${j.message}` : `${label}…`, progress: (i + Math.max(0, j.progress)) / todo.length } })),
        i === 0 && resumePhase === 'transcribe' ? resumeJob : undefined,
      )
      patch((st) => ({ transcribed: [...st.transcribed, id] }))
    }
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    s = get()
    const writing = isIdea(s) ? 'Planning the scenes and writing your script…' : 'Writing your script…'
    patch({ run: { status: 'running', phase: 'script', message: writing, progress: -1 } })
    const job = await runJob(
      patch,
      () => api.produceScript({ projectId: s.projectId!, assetIds: ids, brief: s.brief }),
      (j) => patch((st) => ({ run: { ...st.run, message: j.message || writing, progress: j.progress } })),
      resumePhase === 'script' ? resumeJob : undefined,
    )
    const scenes = job.result?.script?.scenes ?? []
    if (!scenes.length) throw new Error('The script came back empty. Try adding more detail to the brief.')
    // the script job saved these (and the brief it wrote from) to the project
    markDraftSaved({ ...get(), scenes, scriptBrief: s.brief })
    patch({ scenes, scriptBrief: s.brief, step: 'review', run: { status: 'done', phase: 'script', message: `Script ready — ${scenes.length} scenes` } })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      // Only the run that was cancelled reports it; a run superseded by a newer one stays silent.
      if (abort?.signal === signal) patch((st) => ({ run: { ...st.run, status: 'idle', message: 'Stopped', jobId: undefined, interrupted: false } }))
    } else if (abort?.signal === signal) patch((st) => ({ run: { ...st.run, status: 'error', error: errMsg(e) } }))
  }
}

/**
 * Narrate and assemble with the brief as it is now. A timeline edited since the last assembly makes the server ask
 * (run.confirm = 'edited'); then `replace` replaces it, or `intoCopy` assembles into a copy, which the wizard follows
 * (`onProject` gets its id).
 */
export async function runAssemble(opts: { replace?: boolean; intoCopy?: boolean; onProject?: (id: string) => void } = {}) {
  abort?.abort()
  abort = new AbortController()
  const signal = abort.signal
  const { patch } = scoped()
  const s = get()
  if (!s.projectId) return
  let projectId = s.projectId
  const resumeJob = s.run.interrupted && s.run.phase === 'assemble' ? s.run.jobId : undefined
  patch({ step: 'assemble', run: { status: 'running', phase: 'assemble', message: 'Narrating and assembling your video…', progress: 0 } })
  try {
    const job = await runJob(
      patch,
      async () => {
        const j = await api.produceAssemble({ projectId, scenes: s.scenes, brief: s.brief, ...(opts.replace ? { replace: true } : {}), ...(opts.intoCopy ? { intoCopy: true } : {}) })
        if (j.projectId && j.projectId !== projectId) {
          // into a copy: the wizard follows the copy; the edited project stays as it is
          ssSet(storageKey(projectId), undefined)
          projectId = j.projectId
          patch({ projectId, assembledVersion: undefined, assembledFrom: undefined })
          opts.onProject?.(projectId)
        }
        return j
      },
      (j) => patch((st) => ({ run: { ...st.run, message: j.message || 'Assembling…', progress: j.progress } })),
      resumeJob,
    )
    if (signal.aborted) return
    // the timeline was edited while it ran: those edits were kept and the assembly went into a copy, which we follow
    const copyId = (job.result as { copyProjectId?: string } | undefined)?.copyProjectId
    if (copyId) {
      ssSet(storageKey(projectId), undefined)
      projectId = copyId
      patch({ projectId })
      opts.onProject?.(projectId)
    }
    // the server saved scene voices and visuals with what it made (so re-assembling reuses them): keep the wizard in step
    const fresh = await api.project(projectId).catch(() => undefined)
    const done = { ...get(), ...(fresh?.project.ai?.script?.scenes ? { scenes: fresh.project.ai.script.scenes } : {}) }
    markDraftSaved(done)
    patch({
      assembledVersion: job.result?.version,
      assembleNotes: job.result?.notes,
      scenes: done.scenes,
      assembledFrom: draftKey(done),
      run: { status: 'done', phase: 'assemble', message: copyId ? 'Your video is ready, as a copy: someone edited the original’s timeline while it was being assembled, and those edits were kept' : 'Your video is ready' },
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      // Only the run that was cancelled reports it; a run superseded by a newer one stays silent.
      if (abort?.signal === signal) patch((st) => ({ run: { ...st.run, status: 'idle', message: 'Stopped', jobId: undefined, interrupted: false } }))
    } else if (e instanceof HttpError && e.status === 409 && (e.body?.details as { reason?: string } | undefined)?.reason === 'edited') {
      if (abort?.signal === signal) patch({ run: { status: 'idle', phase: 'assemble', confirm: 'edited', message: errMsg(e) } })
    } else if (abort?.signal === signal) patch((st) => ({ run: { ...st.run, status: 'error', error: errMsg(e) } }))
  }
}

export function cancelRun() {
  const id = get().run.jobId
  abort?.abort()
  if (id) api.cancelJob(id).catch(() => undefined)
}
