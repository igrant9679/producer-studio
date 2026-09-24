// Loading, autosave and multi-replica sync. Server projects: debounce 1.2 s -> PUT with baseVersion;
// 409 -> conflict banner (reload theirs / overwrite / keep both). SSE `project` events from other clients or the
// desktop sync engine reload silently when there are no local edits. Demo: localStorage, no network.
import type { Project } from '@producer/core'
import { projectDuration } from '@producer/core'
import { HttpError, api } from '../lib/api'
import { loadDemoProject, saveDemoProject } from './demo'
import { useEditor } from './store'

export const AUTOSAVE_MS = 1200

export async function loadInto(projectId: string, demo: boolean) {
  if (demo) {
    const project = loadDemoProject()
    useEditor.getState().load({ project, version: 0, projectId: 'demo', demo: true })
    return
  }
  const res = await api.project(projectId)
  useEditor.getState().load({ project: res.project, version: res.version, projectId, demo: false, workspaceId: res.summary.workspaceId })
}

let timer: ReturnType<typeof setTimeout> | undefined
let inflight: Promise<void> | null = null
/** Highest server version announced over SSE while a save of ours was in flight. */
let pendingRemote: number | null = null

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
  const base = force && s.conflictVersion !== undefined ? s.conflictVersion : s.version
  useEditor.setState({ saveState: 'saving' })
  try {
    const r = await api.saveProject(s.projectId, project, base)
    const now = useEditor.getState()
    const changed = now.project !== project
    useEditor.setState({ version: r.version, conflictVersion: undefined, conflictProject: undefined, saveState: changed ? 'dirty' : 'saved' })
    if (changed) schedule()
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) {
      const d = (e.body.details ?? {}) as { version?: number; project?: Project }
      useEditor.setState({ saveState: 'conflict', conflictVersion: d.version, conflictProject: d.project })
    } else if (e instanceof HttpError && e.status < 500 && e.status !== 408) {
      // a request the server rejects (401/403/413…) won't succeed on retry
      useEditor.setState({ saveState: 'offline' })
    } else {
      useEditor.setState({ saveState: 'offline' })
      clearTimeout(timer)
      timer = setTimeout(() => void flush(), 5000)
    }
  }
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
      const v = pendingRemote
      pendingRemote = null
      void onProjectEvent({ id: useEditor.getState().projectId, version: v })
    }
  })
  return inflight
}

/** Swap in a server document, keeping the playhead and whatever selection still exists. */
function adoptServerDoc(project: Project, version: number) {
  const s = useEditor.getState()
  const ids = new Set(project.tracks.flatMap((t) => t.items.map((i) => i.id)))
  useEditor.setState({
    project,
    version,
    saveState: 'saved',
    conflictVersion: undefined,
    conflictProject: undefined,
    history: { past: [], future: [] },
    lastCommit: null,
    selection: s.selection.filter((id) => ids.has(id)),
    playhead: Math.min(s.playhead, projectDuration(project)),
    editingTextId: null,
  })
}

/** Conflict: discard local edits and take the other replica's document. */
export async function reloadTheirs() {
  const s = useEditor.getState()
  if (s.conflictProject && s.conflictVersion !== undefined) return adoptServerDoc(s.conflictProject, s.conflictVersion)
  const res = await api.project(s.projectId)
  adoptServerDoc(res.project, res.version)
}

/** Conflict: overwrite the server copy with the local document. */
export async function overwriteServer() {
  const s = useEditor.getState()
  if (s.conflictVersion === undefined) {
    // conflict detected over SSE without a version in hand: fetch it
    const res = await api.project(s.projectId).catch(() => null)
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
  await api.saveProject(created.project.id, doc, created.version)
  // leave the original untouched: don't let the unmount flush retry our conflicting save
  useEditor.setState({ saveState: 'saved', conflictVersion: undefined, conflictProject: undefined })
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
    pendingRemote = Math.max(pendingRemote ?? 0, ev.version)
    return
  }
  if (s.saveState === 'saved') {
    try {
      const res = await api.project(s.projectId)
      // edits may have started while fetching
      if (useEditor.getState().saveState === 'saved' && res.version > useEditor.getState().version) adoptServerDoc(res.project, res.version)
      else if (res.version > useEditor.getState().version) useEditor.setState({ saveState: 'conflict', conflictVersion: res.version, conflictProject: res.project })
    } catch {
      /* next event or save will sort it out */
    }
  } else {
    clearTimeout(timer)
    useEditor.setState({ saveState: 'conflict', conflictVersion: ev.version, conflictProject: undefined })
  }
}

export function startAutosave(): () => void {
  const unsub = useEditor.subscribe((s, prev) => {
    if (s.project !== prev.project && s.loaded && prev.loaded && s.projectId === prev.projectId && s.saveState === 'dirty') schedule()
  })
  const beforeUnload = (e: BeforeUnloadEvent) => {
    const st = useEditor.getState()
    if (st.demo) {
      if (st.loaded) saveDemoProject(st.project)
      return
    }
    if (st.saveState === 'dirty' || st.saveState === 'saving' || st.saveState === 'offline' || st.saveState === 'conflict') {
      e.preventDefault()
      e.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', beforeUnload)
  return () => {
    unsub()
    clearTimeout(timer)
    window.removeEventListener('beforeunload', beforeUnload)
  }
}
