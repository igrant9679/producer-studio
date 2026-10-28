// Loading, autosave and multi-replica sync. Server projects: debounce 1.2 s -> PUT with baseVersion. A 409 (another
// tab, teammate or device saved first) merges the local changes onto the server's version when they don't overlap
// (rebase.ts) and saves again; only when they do is there a conflict banner (reload theirs / overwrite / keep both).
// Other 4xx -> "Not saved" with the server's reason (401: sign in again; 413: what is large). Unreachable or a
// server error -> retried on a schedule (5 s doubling to a minute) that the top bar counts down. Unsaved changes are
// also kept in this browser (journal.ts) until the server has them, and offered back when the project opens again.
// SSE `project` events from other clients or the desktop sync engine reload silently when there are no local edits
// and merge when there are. Version history (P-15/E-3): preview, restore and name saved versions. Demo: localStorage.
import type { Project } from '@producer/core'
import { projectDuration } from '@producer/core'
import { HttpError, api } from '../lib/api'
import { useSession } from '../lib/session'
import { loadDemoProject, saveDemoProject } from './demo'
import { clearJournal, readJournal, writeJournal } from './journal'
import { rebase, rebaseDetailed, same } from './rebase'
import { shareUnchanged, useEditor, type EditorState, type HistoryEntry } from './store'

export const AUTOSAVE_MS = 1200
/** First wait before retrying a save that didn't get through; it doubles up to RETRY_MAX_MS. */
export const RETRY_MS = 5000
export const RETRY_MAX_MS = 60_000
/** Unsaved changes reach this browser's journal this long after the last edit (and at once when the tab closes). */
export const JOURNAL_MS = 400
/** Undo steps carried across an automatic merge (older ones are dropped: undoing past it would undo their work). */
const MERGE_HISTORY = 50

let loading = 0
/** Whose journal this visit writes: the person signed in when the project opened (it survives a sign-out). */
let journalUser = 'me'
/** Automatic retries in a row, for the backoff. */
let retries = 0

export async function loadInto(projectId: string, demo: boolean) {
  const ticket = ++loading
  retries = 0
  if (demo) {
    const project = loadDemoProject()
    useEditor.getState().load({ project, version: 0, projectId: 'demo', demo: true })
    return
  }
  const res = await api.project(projectId)
  // another project was opened while this one was on its way
  if (ticket !== loading) return
  journalUser = useSession.getState().user?.id ?? 'me'
  useEditor.getState().load({ project: res.project, version: res.version, projectId, demo: false, workspaceId: res.summary.workspaceId })
  offerJournal(projectId, res.project)
}

/** Same document, apart from when it was last stamped. */
const sameDoc = (a: Project, b: Project) => same({ ...a, updatedAt: 0 }, { ...b, updatedAt: 0 })

/** Changes kept in this browser from an earlier visit: offered back unless the server already has them. */
function offerJournal(projectId: string, server: Project) {
  const j = readJournal(journalUser, projectId)
  if (!j) return
  if (sameDoc(j.project, savePayload(server))) return clearJournal(journalUser, projectId)
  useEditor.setState({ journalOffer: { savedAt: j.savedAt, baseVersion: j.baseVersion, project: j.project } })
}

/** Keep (or, once the server has everything, drop) this visit's unsaved changes in the browser. */
function writeJournalNow() {
  const s = useEditor.getState()
  // an offer not yet answered stays as it is: answering it decides
  if (s.demo || !s.loaded || s.journalOffer) return
  if (s.saveState === 'saved') return clearJournal(journalUser, s.projectId)
  writeJournal({ projectId: s.projectId, userId: journalUser, baseVersion: s.version, project: savePayload(s.project) })
}

let journalTimer: ReturnType<typeof setTimeout> | undefined
function journalSoon() {
  clearTimeout(journalTimer)
  journalTimer = setTimeout(writeJournalNow, JOURNAL_MS)
}

/** "Restore unsaved changes": bring them back as one undoable edit; the autosave takes it from there. */
export async function restoreJournal(): Promise<void> {
  const s = useEditor.getState()
  const j = s.journalOffer
  if (!j) return
  // the clips' media records: the server's are the freshest
  const mine: Project = { ...j.project, assets: { ...j.project.assets } }
  for (const id of Object.keys(mine.assets)) if (s.project.assets[id]) mine.assets[id] = s.project.assets[id]
  if (j.baseVersion === s.version) {
    useEditor.setState({ journalOffer: undefined })
    useEditor.getState().commit(mine, 'Restore unsaved changes')
    return
  }
  // saved elsewhere since: merge them onto what's saved now, from the version they were made on
  const base = await Promise.resolve()
    .then(() => api.versionAt(s.projectId, j.baseVersion))
    .then((r) => r.project ?? null)
    .catch(() => null)
  const now = useEditor.getState()
  if (now.session !== s.session) return
  const r = base ? rebaseDetailed(base, now.project, mine) : { conflict: 'the project (the version these changes were made on is no longer in the history)' }
  useEditor.setState({ journalOffer: undefined })
  if ('project' in r) return now.commit(r.project, 'Restore unsaved changes')
  // they can't be combined: show mine, and let the conflict banner decide against what's saved
  const server = now.project
  now.commit(mine, 'Restore unsaved changes')
  clearTimeout(timer)
  useEditor.setState({ saveState: 'conflict', conflictVersion: now.version, conflictProject: server, conflictWhat: r.conflict })
}

/** "Discard": forget the changes kept in this browser. */
export function discardJournal() {
  const s = useEditor.getState()
  clearJournal(journalUser, s.projectId)
  useEditor.setState({ journalOffer: undefined })
}

/**
 * What a save sends: the document without the heavy parts of the server's own media records (waveform peaks, a
 * transcript made by transcription), which the server keeps with the clip and puts back on every load. A transcript
 * that exists only in the document (estimated word timings for a generated voice) is kept.
 */
export function savePayload(p: Project): Project {
  let assets: Project['assets'] | undefined
  for (const [id, a] of Object.entries(p.assets)) {
    if (!a.src?.startsWith('/api/media/')) continue
    const dropTranscript = !!a.transcript && a.transcript.engine !== 'estimate'
    if (!a.waveform && !dropTranscript) continue
    const { waveform: _w, transcript, ...rest } = a
    ;(assets ??= { ...p.assets })[id] = dropTranscript || !transcript ? rest : { ...rest, transcript }
  }
  return assets ? { ...p, assets } : p
}

const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length
const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** A 413 in words: how big the project is and its largest part. */
export function tooLargeMessage(p: Project): string {
  const payload = savePayload(p)
  const parts: Array<[string, number]> = payload.tracks.map((t) => [`the ${t.kind === 'caption' ? 'captions' : t.kind} track “${t.name}” (${t.items.length} item${t.items.length === 1 ? '' : 's'})`, bytes(t)])
  parts.push(['the clips’ media records (transcripts and waveforms kept in the project)', bytes(payload.assets)])
  const [what, size] = parts.reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0])
  return `This project is too large to save (${mb(bytes(payload))}). The largest part is ${what}, ${mb(size)}. Remove some of it, or split the project, and it saves again. Your changes are kept in this browser meanwhile.`
}

let timer: ReturnType<typeof setTimeout> | undefined
let inflight: Promise<void> | null = null
/** Highest server version announced over SSE while a save of ours was in flight, and the visit it was for. */
let pendingRemote: { session: number; version: number } | null = null

const transientStatus = (s: number) => s === 408 || s === 429 || s >= 500

async function saveNow(force = false): Promise<void> {
  const s = useEditor.getState()
  if (!s.loaded) return
  if (s.demo) {
    saveDemoProject(s.project)
    useEditor.setState({ saveState: 'saved' })
    return
  }
  if (s.saveState === 'conflict' && !force) return
  if (s.saveState === 'saved' && !force) return
  const project = s.project
  const session = s.session
  const base = force && s.conflictVersion !== undefined ? s.conflictVersion : s.version
  useEditor.setState({ saveState: 'saving', saveRetryAt: undefined })
  try {
    const r = await api.saveProject(s.projectId, savePayload(project), base)
    const now = useEditor.getState()
    // another project, or this one again, was opened meanwhile: its own load and live updates are what count
    if (now.session !== session) return
    retries = 0
    const changed = now.project !== project
    useEditor.setState({ version: r.version, base: project, conflictVersion: undefined, conflictProject: undefined, conflictWhat: undefined, saveError: undefined, saveState: changed ? 'dirty' : 'saved' })
    if (changed) schedule()
    else if (!now.journalOffer) clearJournal(journalUser, now.projectId)
  } catch (e) {
    if (useEditor.getState().session !== session) return
    if (e instanceof HttpError && e.status === 409) {
      const d = (e.body.details ?? {}) as { version?: number; project?: Project }
      const what = d.project && d.version !== undefined ? mergeOnto(d.project, d.version) : 'the project'
      if (what !== null) useEditor.setState({ saveState: 'conflict', conflictVersion: d.version, conflictProject: d.project, conflictWhat: d.project ? what : undefined })
    } else if (e instanceof HttpError && !transientStatus(e.status)) {
      // refused (signed out, no access, invalid, too large): the same request won't succeed on retry, so say why.
      // The next edit, "Try again" or coming back to the tab (or signing in again) tries again.
      useEditor.setState({ saveState: 'error', saveError: { status: e.status, message: refusalMessage(e, project) } })
    } else {
      // can't reach the server (or it failed): try again on a schedule the top bar shows
      const wait = Math.min(RETRY_MS * 2 ** retries, RETRY_MAX_MS)
      retries++
      const unreachable = !(e instanceof HttpError) || e.status === 502 || e.status === 503 || e.status === 504
      useEditor.setState({
        saveState: unreachable ? 'offline' : 'error',
        saveError: unreachable ? undefined : { status: (e as HttpError).status, message: `The server couldn’t save your latest changes (${(e as HttpError).message}). They’re kept in this browser, and saving tries again on its own.` },
        saveRetryAt: Date.now() + wait,
      })
      clearTimeout(timer)
      timer = setTimeout(() => void flush(), wait)
    }
  }
}

/** A refused save in words. */
function refusalMessage(e: HttpError, project: Project): string {
  if (e.status === 401) return 'You were signed out, so your changes aren’t being saved. They’re kept in this browser: sign in again and they’ll save from here.'
  if (e.status === 403) return 'You can no longer edit this project (your role in this space may have changed). Your changes are only in this browser.'
  if (e.status === 404) return 'This project no longer exists on the server. Your changes are only in this browser.'
  if (e.status === 413) return tooLargeMessage(project)
  return `The server refused this version: ${e.message}`
}

/** Each undo step with the same changes merged in; from the first that can't take them, the older ones go. */
function rebaseHistory(base: Project, theirs: Project, h: EditorState['history']): EditorState['history'] {
  const carry = (entries: HistoryEntry[]) => {
    const out: HistoryEntry[] = []
    for (const e of entries) {
      const p = rebase(base, theirs, e.project)
      if (!p) break
      out.push({ ...e, project: p })
    }
    return out
  }
  const past = carry([...h.past].reverse().slice(0, MERGE_HISTORY)).reverse()
  return { past, future: carry(h.future.slice(0, MERGE_HISTORY)) }
}

/**
 * Another replica saved `theirs` as `version` while we had unsaved changes: put ours on top when they don't overlap
 * and save that. Returns null when merged, otherwise what both sides changed (in words).
 */
function mergeOnto(theirs: Project, version: number): string | null {
  const s = useEditor.getState()
  if (!s.base) return 'the project'
  const r = rebaseDetailed(s.base, theirs, s.project)
  if ('conflict' in r) return r.conflict
  const project = shareUnchanged(s.project, r.project)
  const ids = new Set(project.tracks.flatMap((t) => t.items.map((i) => i.id)))
  useEditor.setState({
    project,
    version,
    base: theirs,
    history: rebaseHistory(s.base, theirs, s.history),
    lastCommit: null,
    selection: s.selection.filter((id) => ids.has(id)),
    saveState: 'dirty',
    conflictVersion: undefined,
    conflictProject: undefined,
    conflictWhat: undefined,
  })
  schedule()
  return null
}

function schedule() {
  clearTimeout(timer)
  timer = setTimeout(() => void flush(), AUTOSAVE_MS)
}

/** Save immediately (awaits an in-flight save first). */
export async function flush(force = false): Promise<void> {
  clearTimeout(timer)
  if (inflight) await inflight
  inflight = saveNow(force).finally(() => {
    inflight = null
    // an SSE event arrived mid-save: if it announced a version newer than the one we just wrote, handle it now
    if (pendingRemote !== null) {
      const { session, version } = pendingRemote
      pendingRemote = null
      const s = useEditor.getState()
      if (s.session === session) void onProjectEvent({ id: s.projectId, version })
    }
  })
  return inflight
}

/** Save what's on screen and wait for it. Returns null once the server has it, otherwise why it doesn't. */
async function saveFirst(): Promise<string | null> {
  // edits made while a save is out leave it 'dirty': go round again
  for (let i = 0; i < 3 && useEditor.getState().saveState !== 'saved'; i++) {
    await flush()
    if (useEditor.getState().saveState !== 'dirty') break
  }
  const s = useEditor.getState()
  if (s.saveState === 'saved') return null
  if (s.saveState === 'conflict') return 'This project was also changed somewhere else, so your version isn’t saved yet. Resolve the conflict (the banner at the top) first.'
  if (s.saveState === 'error') return s.saveError?.message ?? 'The server refused your latest changes.'
  if (s.saveState === 'offline') return 'Can’t reach the server, so your latest changes aren’t saved yet. Try again once you’re back online.'
  return 'Your latest changes are still saving. Try again in a moment.'
}

/**
 * Save what's on screen and wait for it (export renders the server's copy). Returns null once the server has it,
 * otherwise why it doesn't.
 */
export async function saveForExport(): Promise<string | null> {
  const why = await saveFirst()
  if (!why) return null
  const s = useEditor.getState()
  if (s.saveState === 'conflict') return 'This project was also changed somewhere else, so your version isn’t saved yet. Resolve the conflict (the banner at the top), then export.'
  if (s.saveState === 'error') return `${why} Export renders the saved version, so it waits until they’re saved.`
  if (s.saveState === 'offline') return 'Can’t reach the server, so your latest changes aren’t saved yet. Export renders the saved version: try again once you’re back online.'
  return why
}

/** Swap in a server document, keeping the playhead and whatever selection still exists. */
function adoptServerDoc(project: Project, version: number) {
  const s = useEditor.getState()
  const ids = new Set(project.tracks.flatMap((t) => t.items.map((i) => i.id)))
  useEditor.setState({
    project,
    version,
    base: project,
    saveState: 'saved',
    saveError: undefined,
    saveRetryAt: undefined,
    conflictVersion: undefined,
    conflictProject: undefined,
    conflictWhat: undefined,
    versionPreview: undefined,
    history: { past: [], future: [] },
    lastCommit: null,
    selection: s.selection.filter((id) => ids.has(id)),
    playhead: Math.min(s.playhead, projectDuration(project)),
    editingTextId: null,
  })
  clearTimeout(timer)
  if (!s.journalOffer) clearJournal(journalUser, s.projectId)
}

/** Conflict: discard local edits and take the other replica's document. */
export async function reloadTheirs() {
  const s = useEditor.getState()
  if (s.conflictProject && s.conflictVersion !== undefined) return adoptServerDoc(s.conflictProject, s.conflictVersion)
  const res = await api.project(s.projectId)
  if (useEditor.getState().session === s.session) adoptServerDoc(res.project, res.version)
}

/** Conflict: overwrite the server copy with the local document. */
export async function overwriteServer() {
  const s = useEditor.getState()
  if (s.conflictVersion === undefined) {
    // conflict detected over SSE without a version in hand: fetch it
    const res = await api.project(s.projectId).catch(() => null)
    if (useEditor.getState().session !== s.session) return
    if (res) useEditor.setState({ conflictVersion: res.version })
  }
  await flush(true)
}

/**
 * Conflict: keep both. Saves the local document as a new project "… (conflicted copy)" and returns its id so the
 * caller can open it; the original stays as the other replica saved it.
 */
export async function keepBoth(): Promise<string> {
  const s = useEditor.getState()
  if (!s.workspaceId) throw new Error('No workspace for this project')
  const name = `${s.project.name || 'Untitled'} (conflicted copy)`
  const created = await api.createProject({ workspaceId: s.workspaceId, name, width: s.project.width, height: s.project.height, fps: s.project.fps })
  const doc: Project = { ...s.project, id: created.project.id, name }
  await api.saveProject(created.project.id, savePayload(doc), created.version)
  // leave the original untouched: don't let the unmount flush retry our conflicting save
  if (useEditor.getState().session === s.session) {
    useEditor.setState({ saveState: 'saved', conflictVersion: undefined, conflictProject: undefined, conflictWhat: undefined })
    clearJournal(journalUser, s.projectId)
  }
  return created.project.id
}

export async function reloadFromServer() {
  await reloadTheirs()
}

/** SSE `project` event: another client or the sync engine saved a version of a project. */
export async function onProjectEvent(ev: { id: string; version: number }) {
  const s = useEditor.getState()
  if (s.demo || !s.loaded || ev.id !== s.projectId || ev.version <= s.version) return
  if (inflight) {
    // probably our own save echoing back; decide once it resolves
    pendingRemote = { session: s.session, version: Math.max(pendingRemote?.session === s.session ? pendingRemote.version : 0, ev.version) }
    return
  }
  if (s.saveState === 'conflict') {
    // the banner stays; "overwrite" should replace the newest version
    useEditor.setState({ conflictVersion: ev.version, conflictProject: undefined })
    return
  }
  const res = await Promise.resolve()
    .then(() => api.project(s.projectId))
    .catch(() => undefined)
  const now = useEditor.getState()
  if (now.session !== s.session) return
  if (!res?.project || typeof res.version !== 'number') {
    // can't see what they saved: with edits of ours, don't save over it unseen
    if (now.saveState !== 'saved') {
      clearTimeout(timer)
      useEditor.setState({ saveState: 'conflict', conflictVersion: ev.version, conflictProject: undefined })
    }
    return
  }
  if (res.version <= now.version) return
  // no edits here (none started while fetching either): take theirs as it is
  if (now.saveState === 'saved') return adoptServerDoc(res.project, res.version)
  const what = mergeOnto(res.project, res.version)
  if (what !== null) {
    clearTimeout(timer)
    useEditor.setState({ saveState: 'conflict', conflictVersion: res.version, conflictProject: res.project, conflictWhat: what })
  }
}

/** The live stream missed events it can't replay: look at the server's version, as the missed event would have. */
export async function resyncProject() {
  const s = useEditor.getState()
  if (s.demo || !s.loaded) return
  try {
    const res = await api.project(s.projectId)
    if (useEditor.getState().session === s.session && res.version > useEditor.getState().version) await onProjectEvent({ id: s.projectId, version: res.version })
  } catch {
    /* the next event or save sorts it out */
  }
}

// ---- version history (E-3) ----

/** Show a saved version read-only on the canvas. */
export async function previewVersion(versionId: string, label: string): Promise<void> {
  const s = useEditor.getState()
  const r = await api.version(s.projectId, versionId)
  if (useEditor.getState().session !== s.session) return
  useEditor.setState({ versionPreview: { id: versionId, label, project: r.project }, playing: false, selection: [], editingTextId: null })
}

export function endPreview() {
  useEditor.setState({ versionPreview: undefined })
}

/**
 * Bring a saved version back: what's on screen is saved first (so it is in the history too, as "before restore"),
 * then the server saves the version as a new one and the editor opens it.
 */
export async function restoreVersion(versionId: string): Promise<void> {
  const why = await saveFirst()
  if (why) throw new Error(`${why} Restoring waits until they’re saved, so they stay in the history.`)
  const s = useEditor.getState()
  await api.restoreVersion(s.projectId, versionId, s.version)
  const res = await api.project(s.projectId)
  if (useEditor.getState().session === s.session) adoptServerDoc(res.project, res.version)
}

/** Name what's on screen ("Sent to client"): saved first, then kept for good. */
export async function nameCurrentVersion(name: string): Promise<void> {
  const why = await saveFirst()
  if (why) throw new Error(`${why} A version can be named once it’s saved.`)
  await api.nameCurrentVersion(useEditor.getState().projectId, name)
}

export function startAutosave(): () => void {
  const unsub = useEditor.subscribe((s, prev) => {
    if (s.project !== prev.project && s.loaded && prev.loaded && s.projectId === prev.projectId && s.saveState === 'dirty') schedule()
    // an edit (or a newer version arriving) ends a preview of an older one
    if (s.project !== prev.project && s.versionPreview && s.versionPreview === prev.versionPreview) useEditor.setState({ versionPreview: undefined })
    if (!s.demo && s.loaded && s.projectId === prev.projectId && (s.project !== prev.project || s.saveState !== prev.saveState)) journalSoon()
  })
  const keepNow = () => {
    clearTimeout(journalTimer)
    writeJournalNow()
  }
  const beforeUnload = (e: BeforeUnloadEvent) => {
    const st = useEditor.getState()
    if (st.demo) {
      if (st.loaded) saveDemoProject(st.project)
      return
    }
    keepNow()
    if (st.saveState !== 'saved') {
      e.preventDefault()
      e.returnValue = ''
    }
  }
  // back from signing in (or fixing access) in another tab: try the refused save again
  const onFocus = () => {
    if (useEditor.getState().saveState === 'error') void flush()
  }
  // the network came back: don't wait for the scheduled retry
  const onOnline = () => {
    const st = useEditor.getState().saveState
    if (st === 'offline' || st === 'error') void flush()
  }
  // signed in again (this tab or another) as the same person: the refused save goes through
  const unsubSession = useSession.subscribe((ss, prev) => {
    const st = useEditor.getState()
    if (ss.user?.id && ss.user.id !== prev.user?.id && ss.user.id === journalUser && st.saveState === 'error' && st.saveError?.status === 401) void flush()
  })
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('pagehide', keepNow)
  window.addEventListener('focus', onFocus)
  window.addEventListener('online', onOnline)
  return () => {
    unsub()
    unsubSession()
    clearTimeout(timer)
    keepNow()
    window.removeEventListener('beforeunload', beforeUnload)
    window.removeEventListener('pagehide', keepNow)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('online', onOnline)
  }
}
