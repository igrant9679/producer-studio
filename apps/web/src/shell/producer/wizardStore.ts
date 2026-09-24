// Wizard state lives in a module store so long-running steps (uploads, transcription, script, assembly)
// keep going across route changes/remounts. Every change is mirrored to sessionStorage per project.
import type { AssetRecord, Job } from '@producer/core'
import { create } from 'zustand'
import { api, HttpError, waitForJob } from '../../lib/api'
import { useJobs, waitForAssetReady } from '../stores'
import { aspectFor, ssSet } from '../util'
import { readyAssetIds, storageKey, type WizardAsset, type WizardState, initialState } from './wizardLogic'

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

export async function uploadToWizard(workspaceId: string, files: File[]) {
  const { patch, patchAsset } = scoped()
  const items: Array<{ file: File; localId: string }> = files.map((file) => ({ file, localId: `l${Date.now().toString(36)}${++n}` }))
  patch((s) => ({ assets: [...s.assets, ...items.map(({ file, localId }) => ({ localId, name: file.name, size: file.size, status: 'uploading' as const, progress: 0 }))] }))
  await Promise.all(
    items.map(async ({ file, localId }) => {
      try {
        const rec = await api.upload(workspaceId, file, (f) => patchAsset(localId, { progress: f }))
        patchAsset(localId, { assetId: rec.asset.id, status: rec.status === 'ready' ? 'ready' : 'processing', progress: 1, duration: rec.asset.duration })
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
    patchAsset(localId, { status: 'ready', duration: ready.asset.duration, name: ready.asset.name })
  } catch (e) {
    patchAsset(localId, { status: 'error', error: errMsg(e) })
  }
}

/** After a refresh: keep waiting on assets that were still processing. */
export function resumeProcessingAssets() {
  for (const a of get().assets) if (a.status === 'processing' && a.assetId) void waitAsset(a.localId, a.assetId)
}

export function addLibraryAssets(recs: AssetRecord[]) {
  patch((s) => {
    const have = new Set(s.assets.map((a) => a.assetId))
    const add = recs
      .filter((r) => !have.has(r.asset.id))
      .map((r) => ({ localId: r.asset.id, assetId: r.asset.id, name: r.asset.name, size: r.asset.sizeBytes ?? 0, status: r.status === 'ready' ? ('ready' as const) : r.status === 'error' ? ('error' as const) : ('processing' as const), progress: 1, duration: r.asset.duration }))
    return { assets: [...s.assets, ...add] }
  })
  for (const r of recs) if (r.status !== 'ready' && r.status !== 'error') void waitAsset(r.asset.id, r.asset.id)
}

export function removeWizardAsset(localId: string) {
  patch((s) => ({ assets: s.assets.filter((a) => a.localId !== localId) }))
}

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
    const ids = readyAssetIds(s)
    const todo = ids.filter((id) => !s.transcribed.includes(id))
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
    patch({ run: { status: 'running', phase: 'script', message: 'Claude is writing your script…', progress: -1 } })
    const job = await runJob(
      patch,
      () => api.produceScript({ projectId: s.projectId!, assetIds: ids, brief: s.brief }),
      (j) => patch((st) => ({ run: { ...st.run, message: j.message || 'Claude is writing your script…', progress: j.progress } })),
      resumePhase === 'script' ? resumeJob : undefined,
    )
    const scenes = job.result?.script?.scenes ?? []
    if (!scenes.length) throw new Error('The script came back empty. Try adding more detail to the brief.')
    patch({ scenes, step: 'review', run: { status: 'done', phase: 'script', message: `Script ready — ${scenes.length} scenes` } })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      // Only the run that was cancelled reports it; a run superseded by a newer one stays silent.
      if (abort?.signal === signal) patch((st) => ({ run: { ...st.run, status: 'idle', message: 'Stopped', jobId: undefined, interrupted: false } }))
    } else if (abort?.signal === signal) patch((st) => ({ run: { ...st.run, status: 'error', error: errMsg(e) } }))
  }
}

export async function runAssemble() {
  abort?.abort()
  abort = new AbortController()
  const signal = abort.signal
  const { patch } = scoped()
  const s = get()
  if (!s.projectId) return
  const resumeJob = s.run.interrupted && s.run.phase === 'assemble' ? s.run.jobId : undefined
  patch({ step: 'assemble', run: { status: 'running', phase: 'assemble', message: 'Narrating and assembling your video…', progress: 0 } })
  try {
    const job = await runJob(
      patch,
      () => api.produceAssemble(s.projectId!, s.scenes),
      (j) => patch((st) => ({ run: { ...st.run, message: j.message || 'Assembling…', progress: j.progress } })),
      resumeJob,
    )
    if (signal.aborted) return
    patch({ assembledVersion: job.result?.version, run: { status: 'done', phase: 'assemble', message: 'Your video is ready' } })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      // Only the run that was cancelled reports it; a run superseded by a newer one stays silent.
      if (abort?.signal === signal) patch((st) => ({ run: { ...st.run, status: 'idle', message: 'Stopped', jobId: undefined, interrupted: false } }))
    } else if (abort?.signal === signal) patch((st) => ({ run: { ...st.run, status: 'error', error: errMsg(e) } }))
  }
}

export function cancelRun() {
  const id = get().run.jobId
  abort?.abort()
  if (id) api.cancelJob(id).catch(() => undefined)
}
