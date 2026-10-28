// Editor state. Every edit goes through `commit(next, label)` which pushes the previous document onto the undo
// stack. Rapid edits that share a `coalesce` key (slider drags, trims, canvas drags) collapse into one entry.
// What an edit didn't change stays the same object (shareUnchanged), so undo steps share it.
// Media records from the server go through `updateMedia` and are never undone.
import type { Asset, Item, Project } from '@producer/core'
import { create } from 'zustand'

/** `offline`: the server couldn't be reached (retries on its own). `error`: the server refused the save (see saveError). */
export type SaveState = 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict' | 'error'
export type LeftTab = 'media' | 'audio' | 'text' | 'captions' | 'transcript' | 'effects' | 'transitions' | 'filters' | 'brand' | 'ai'
export type CanvasTool = 'select' | 'hand'

export interface HistoryEntry {
  project: Project
  label: string
  selection: string[]
}

export const HISTORY_CAP = 200
/** The longest project name the server accepts. */
export const PROJECT_NAME_MAX = 200
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
  /** Counts loads: answers that arrive after another project (or the same one again) was opened are dropped. */
  session: number
  project: Project
  /** Freshest media records that arrived during this visit, including clips the current document no longer has. */
  media: Record<string, Asset>
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
  /** Media records the clipboard's clips need, and the space they were copied in (another space can't load them). */
  clipboardMedia: { workspaceId?: string; assets: Record<string, Asset> }
  activeLeftTab: LeftTab
  activeRightTab: string
  leftCollapsed: boolean
  rightCollapsed: boolean
  saveState: SaveState
  /** Why the last save was refused (HTTP status and a sentence for the person), while saveState is 'error'. */
  saveError?: { status: number; message: string }
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
  /** Replace the project without an undo entry. */
  replaceSilently: (next: Project) => void
  /**
   * A media record (duration, proxy, waveform, transcript…) arrived from the server. It goes into the project
   * without an undo entry and stays out of history: undo and redo keep the freshest record of every clip.
   */
  updateMedia: (asset: Pick<Asset, 'id'> & Partial<Asset>) => void
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

/** Equal plain data (documents are JSON). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((x, i) => same(x, bb[i]))
  }
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/**
 * `next` with every track, item and media record an edit left alone replaced by the object `prev` already had. Ops
 * copy the whole document; this keeps one copy of what didn't change, so undo steps share it and the timeline
 * re-renders only the clips that did.
 */
export function shareUnchanged(prev: Project, next: Project): Project {
  if (prev === next) return next
  const oldTracks = new Map(prev.tracks.map((t) => [t.id, t]))
  const oldItems = new Map<string, Item>()
  for (const t of prev.tracks) for (const i of t.items) oldItems.set(i.id, i)
  const tracks = next.tracks.map((t) => {
    const items = t.items.map((i) => {
      const o = oldItems.get(i.id)
      return o && o !== i && same(o, i) ? o : i
    })
    const old = oldTracks.get(t.id)
    if (old && old.items.length === items.length && old.items.every((x, k) => x === items[k])) {
      const { items: _a, ...rest } = t
      const { items: _b, ...oldRest } = old
      if (same(rest, oldRest)) return old
    }
    return items.some((x, k) => x !== t.items[k]) ? { ...t, items } : t
  })
  let assets = next.assets
  for (const [id, a] of Object.entries(next.assets)) {
    const o = prev.assets[id]
    if (o && o !== a && same(o, a)) (assets === next.assets ? (assets = { ...next.assets }) : assets)[id] = o
  }
  return { ...next, tracks: tracks.every((t, k) => t === next.tracks[k]) ? next.tracks : tracks, assets }
}

function findInHistory(s: EditorState, assetId: string): Asset | undefined {
  // newest step first
  for (const e of [...s.history.past, ...s.history.future].reverse()) if (e.project.assets[assetId]) return e.project.assets[assetId]
  return undefined
}

/** `target` (an undo or redo step) with each media record swapped for the freshest one: records aren't history. */
function withFreshMedia(target: Project, s: EditorState): Project {
  let assets: Project['assets'] | undefined
  for (const id of Object.keys(target.assets)) {
    const fresh = s.project.assets[id] ?? s.media[id]
    if (fresh && fresh !== target.assets[id]) (assets ??= { ...target.assets })[id] = fresh
  }
  return assets ? { ...target, assets } : target
}

export const useEditor = create<EditorState>((set, get) => ({
  loaded: false,
  demo: false,
  projectId: '',
  session: 0,
  project: emptyProject(),
  media: {},
  version: 0,
  history: { past: [], future: [] },
  lastCommit: null,
  selection: [],
  playhead: 0,
  playing: false,
  zoom: 80,
  snapping: true,
  clipboard: [],
  clipboardMedia: { assets: {} },
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
      session: get().session + 1,
      media: {},
      history: { past: [], future: [] },
      lastCommit: null,
      selection: [],
      playhead: 0,
      playing: false,
      saveState: 'saved',
      saveError: undefined,
      conflictVersion: undefined,
      conflictProject: undefined,
    }),

  commit: (next0, label, opts = {}) => {
    const s = get()
    if (next0 === s.project) {
      if (opts.selection) set({ selection: opts.selection })
      return
    }
    const next = shareUnchanged(s.project, next0)
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

  replaceSilently: (next) => set({ project: shareUnchanged(get().project, next), saveState: get().saveState === 'conflict' ? 'conflict' : 'dirty' }),

  updateMedia: (asset) => {
    const s = get()
    const id = asset.id
    const inDoc = !!s.project.assets[id]
    // only clips this visit knows (the document, or a step of its history); not the whole workspace library
    const known = inDoc || !!s.media[id] || [...s.history.past, ...s.history.future].some((e) => e.project.assets[id])
    if (!known) return
    const record = { ...(s.project.assets[id] ?? s.media[id] ?? findInHistory(s, id)), ...asset } as Asset
    const media = { ...s.media, [id]: record }
    if (!inDoc) return set({ media })
    set({ media, project: { ...s.project, assets: { ...s.project.assets, [id]: record } }, saveState: s.saveState === 'conflict' ? 'conflict' : 'dirty' })
  },

  undo: () => {
    const s = get()
    const prev = s.history.past[s.history.past.length - 1]
    if (!prev) return
    const ids = existingIds(prev.project)
    set({
      project: withFreshMedia(prev.project, s),
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
      project: withFreshMedia(next.project, s),
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
