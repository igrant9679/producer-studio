// Editor state. Every edit goes through `commit(next, label)` which pushes the previous document onto the undo
// stack. Rapid edits that share a `coalesce` key (slider drags, trims, canvas drags) collapse into one entry.
import type { Item, Project } from '@producer/core'
import { create } from 'zustand'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict'
export type LeftTab = 'media' | 'audio' | 'text' | 'captions' | 'transcript' | 'effects' | 'transitions' | 'filters' | 'brand' | 'ai'
export type CanvasTool = 'select' | 'hand'

export interface HistoryEntry {
  project: Project
  label: string
  selection: string[]
}

export const HISTORY_CAP = 200
/** Commits with the same coalesce key within this window merge into one undo entry. */
export const COALESCE_MS = 1200

export interface CommitOptions {
  /** Merge with the previous commit when it used the same key (and was recent). */
  coalesce?: string
  /** Selection to set together with the change. */
  selection?: string[]
}

export interface EditorState {
  loaded: boolean
  demo: boolean
  projectId: string
  workspaceId?: string
  project: Project
  /** Server version of the last saved document. */
  version: number
  history: { past: HistoryEntry[]; future: HistoryEntry[] }
  lastCommit: { label: string; key?: string; at: number } | null
  selection: string[]
  playhead: number
  playing: boolean
  /** Timeline zoom in px per second. */
  zoom: number
  snapping: boolean
  clipboard: Item[]
  activeLeftTab: LeftTab
  activeRightTab: string
  leftCollapsed: boolean
  rightCollapsed: boolean
  saveState: SaveState
  /** On a 409 (or a newer server version while we have unsaved edits): the other replica's version/doc. */
  conflictVersion?: number
  conflictProject?: Project
  canvasTool: CanvasTool
  /** Canvas zoom: 'fit' or a scale factor (1 = 100 %). */
  canvasZoom: 'fit' | number
  /** Scale the canvas uses in 'fit' mode (reported by the canvas). */
  canvasFit: number
  buffering: boolean
  editingTextId: string | null
  fullscreen: boolean
  shortcutsOpen: boolean
  exportOpen: boolean

  load: (p: { project: Project; version: number; projectId: string; demo: boolean; workspaceId?: string }) => void
  commit: (next: Project, label: string, opts?: CommitOptions) => void
  /** Ends any open coalescing run (call on pointerup). */
  endCoalesce: () => void
  /** Replace the project without an undo entry (e.g. asset metadata arriving from the server). */
  replaceSilently: (next: Project) => void
  undo: () => void
  redo: () => void
  select: (ids: string[]) => void
  setPlayhead: (t: number) => void
  setPlaying: (on: boolean) => void
  setZoom: (z: number) => void
  set: (patch: Partial<EditorState>) => void
}

export const MIN_ZOOM = 4
export const MAX_ZOOM = 600

const emptyProject = (): Project => ({
  id: 'empty',
  schema: 1,
  name: '',
  width: 1920,
  height: 1080,
  fps: 30,
  background: '#000000',
  tracks: [],
  assets: {},
  createdAt: 0,
  updatedAt: 0,
})

function existingIds(p: Project): Set<string> {
  const s = new Set<string>()
  for (const t of p.tracks) for (const i of t.items) s.add(i.id)
  return s
}

export const useEditor = create<EditorState>((set, get) => ({
  loaded: false,
  demo: false,
  projectId: '',
  project: emptyProject(),
  version: 0,
  history: { past: [], future: [] },
  lastCommit: null,
  selection: [],
  playhead: 0,
  playing: false,
  zoom: 80,
  snapping: true,
  clipboard: [],
  activeLeftTab: 'media',
  activeRightTab: '',
  leftCollapsed: false,
  rightCollapsed: false,
  saveState: 'saved',
  canvasTool: 'select',
  canvasZoom: 'fit',
  canvasFit: 0.5,
  buffering: false,
  editingTextId: null,
  fullscreen: false,
  shortcutsOpen: false,
  exportOpen: false,

  load: ({ project, version, projectId, demo, workspaceId }) =>
    set({
      loaded: true,
      project,
      version,
      projectId,
      demo,
      workspaceId,
      history: { past: [], future: [] },
      lastCommit: null,
      selection: [],
      playhead: 0,
      playing: false,
      saveState: 'saved',
      conflictVersion: undefined,
      conflictProject: undefined,
    }),

  commit: (next, label, opts = {}) => {
    const s = get()
    if (next === s.project) {
      if (opts.selection) set({ selection: opts.selection })
      return
    }
    const now = Date.now()
    const merge = !!opts.coalesce && s.lastCommit?.key === opts.coalesce && now - s.lastCommit.at < COALESCE_MS
    let past = s.history.past
    if (!merge) {
      past = [...past, { project: s.project, label, selection: s.selection }]
      if (past.length > HISTORY_CAP) past = past.slice(past.length - HISTORY_CAP)
    }
    let selection = opts.selection ?? s.selection
    if (!opts.selection) {
      const ids = existingIds(next)
      if (selection.some((id) => !ids.has(id))) selection = selection.filter((id) => ids.has(id))
    }
    set({
      project: next,
      history: { past, future: [] },
      lastCommit: { label, key: opts.coalesce, at: now },
      selection,
      saveState: s.saveState === 'conflict' ? 'conflict' : 'dirty',
    })
  },

  endCoalesce: () => {
    const lc = get().lastCommit
    if (lc?.key) set({ lastCommit: { ...lc, key: undefined } })
  },

  replaceSilently: (next) => set({ project: next, saveState: get().saveState === 'conflict' ? 'conflict' : 'dirty' }),

  undo: () => {
    const s = get()
    const prev = s.history.past[s.history.past.length - 1]
    if (!prev) return
    const ids = existingIds(prev.project)
    set({
      project: prev.project,
      history: { past: s.history.past.slice(0, -1), future: [{ project: s.project, label: prev.label, selection: s.selection }, ...s.history.future] },
      lastCommit: null,
      selection: prev.selection.filter((id) => ids.has(id)),
      saveState: s.saveState === 'conflict' ? 'conflict' : 'dirty',
      editingTextId: null,
    })
  },

  redo: () => {
    const s = get()
    const next = s.history.future[0]
    if (!next) return
    const ids = existingIds(next.project)
    set({
      project: next.project,
      history: { past: [...s.history.past, { project: s.project, label: next.label, selection: s.selection }], future: s.history.future.slice(1) },
      lastCommit: null,
      selection: next.selection.filter((id) => ids.has(id)),
      saveState: s.saveState === 'conflict' ? 'conflict' : 'dirty',
      editingTextId: null,
    })
  },

  select: (ids) => {
    const cur = get().selection
    if (cur.length === ids.length && cur.every((id, i) => id === ids[i])) return
    set({ selection: ids })
  },
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (on) => set({ playing: on }),
  setZoom: (z) => set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) }),
  set: (patch) => set(patch),
}))

/** Label of the next undo/redo step for tooltips. */
export const undoLabel = (s: EditorState) => s.history.past[s.history.past.length - 1]?.label
export const redoLabel = (s: EditorState) => s.history.future[0]?.label

if (import.meta.env?.DEV && typeof window !== 'undefined') (window as unknown as { __psEditor?: typeof useEditor }).__psEditor = useEditor
