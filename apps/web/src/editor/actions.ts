// Editing commands shared by the toolbar, context menu, canvas toolbar and keyboard shortcuts.
import type { AnimProp, Asset, Item, Project, TrackKind, TransitionType, VisualItem } from '@producer/core'
import {
  addAsset,
  addItem,
  clone,
  createAudioItem,
  createImageItem,
  createTextItem,
  createVideoItem,
  deleteItems,
  duplicateItems,
  findItem,
  freezeFrame,
  insertTrack,
  itemEnd,
  mainTrack,
  pasteItems,
  projectDuration,
  sampleKeyframes,
  separateAudio,
  setKeyframe,
  splitAt,
  updateItem,
} from '@producer/core'
import { toast } from '../lib/toast'
import { useEditor } from './store'

const S = () => useEditor.getState()

export function selectedItems(p: Project = S().project, ids = S().selection): Item[] {
  const out: Item[] = []
  for (const id of ids) {
    const f = findItem(p, id)
    if (f) out.push(f.item)
  }
  return out
}

export function primarySelected(): Item | undefined {
  const s = S()
  return s.selection.length ? findItem(s.project, s.selection[s.selection.length - 1])?.item : undefined
}

export function split() {
  const { project, playhead, selection } = S()
  let ids: string[]
  if (selection.length) ids = selectedItems().filter((i) => i.start < playhead && itemEnd(i) > playhead).map((i) => i.id)
  else ids = (mainTrack(project)?.items ?? []).filter((i) => i.start < playhead && itemEnd(i) > playhead).map((i) => i.id)
  if (!ids.length) {
    toast(selection.length ? 'Move the playhead over the selected clip to split it' : 'Nothing under the playhead to split')
    return
  }
  S().commit(splitAt(project, playhead, ids), 'Split')
}

export function remove(ripple = false) {
  const { project, selection } = S()
  if (!selection.length) return
  let p = project
  if (ripple) {
    // ripple on non-main tracks too; core packs main anyway
    p = deleteItems(project, selection, { ripple: true })
  } else {
    // non-ripple delete on the main track still packs (magnetic)
    p = deleteItems(project, selection)
  }
  S().commit(p, ripple ? 'Ripple delete' : 'Delete', { selection: [] })
}

export function copy() {
  const items = selectedItems()
  if (!items.length) return
  S().set({ clipboard: clone(items) })
  toast(`Copied ${items.length} item${items.length > 1 ? 's' : ''}`)
}

export function cut() {
  const items = selectedItems()
  if (!items.length) return
  S().set({ clipboard: clone(items) })
  remove(false)
}

export function paste() {
  const { clipboard, project, playhead } = S()
  if (!clipboard.length) return
  const { project: p, newIds } = pasteItems(project, clipboard, playhead)
  S().commit(p, 'Paste', { selection: newIds })
}

export function duplicate() {
  const { selection, project } = S()
  if (!selection.length) return
  const { project: p, newIds } = duplicateItems(project, selection)
  S().commit(p, 'Duplicate', { selection: newIds })
}

export function selectAll() {
  const p = S().project
  S().select(p.tracks.flatMap((t) => (t.locked ? [] : t.items.map((i) => i.id))))
}

export function separate() {
  const vids = selectedItems().filter((i) => i.type === 'video')
  if (!vids.length) return toast('Select a video clip to separate its audio')
  let p = S().project
  for (const v of vids) p = separateAudio(p, v.id)
  if (p === S().project) return toast('This clip has no audio to separate')
  S().commit(p, 'Separate audio')
}

export function freeze() {
  const { playhead, project } = S()
  const v = selectedItems().find((i) => i.type === 'video' && i.start <= playhead && itemEnd(i) > playhead)
    ?? (mainTrack(project)?.items ?? []).find((i) => i.type === 'video' && i.start <= playhead && itemEnd(i) > playhead)
  if (!v) return toast('Put the playhead over a video clip to freeze a frame')
  S().commit(freezeFrame(project, v.id, playhead, 2), 'Freeze frame')
}

export function setTransition(itemId: string, type: TransitionType | null, duration = 0.6) {
  const { project } = S()
  const f = findItem(project, itemId)
  if (!f || !('transitionOut' in f.item || f.item.type === 'video' || f.item.type === 'image')) return
  const next = f.track.items[f.index + 1]
  if (type && (!next || Math.abs(next.start - itemEnd(f.item)) > 0.05)) {
    toast('Transitions go between two touching clips on the same track')
    return
  }
  S().commit(updateItem<VisualItem>(project, itemId, { transitionOut: type ? { type, duration } : undefined }), type ? 'Add transition' : 'Remove transition')
}

/** Nearest cut (item with an adjacent next clip) for applying a transition to the selection. */
export function transitionTargetFor(itemId: string): string | null {
  const f = findItem(S().project, itemId)
  if (!f) return null
  const next = f.track.items[f.index + 1]
  if (next && Math.abs(next.start - itemEnd(f.item)) < 0.05) return f.item.id
  const prev = f.track.items[f.index - 1]
  if (prev && Math.abs(itemEnd(prev) - f.item.start) < 0.05) return prev.id
  return null
}

// ---------- keyframe-aware property edits ----------

export function localTime(it: Item, playhead = S().playhead) {
  return Math.max(0, Math.min(it.duration, playhead - it.start))
}

type VisualProp = Exclude<AnimProp, 'volume'>

export function readProp(it: Item, prop: AnimProp, playhead = S().playhead): number {
  const lt = localTime(it, playhead)
  const kfs = 'keyframes' in it ? it.keyframes[prop] : undefined
  let base = 0
  if (prop === 'volume') base = 'volume' in it ? it.volume : 1
  else if (prop === 'opacity') base = 'opacity' in it ? it.opacity : 1
  else if ('transform' in it) base = it.transform[prop as keyof typeof it.transform] as number
  return sampleKeyframes(kfs, lt, base)
}

/** Set a numeric prop; if it's keyframed, writes a keyframe at the playhead instead of the base value. */
export function writeProp(p: Project, itemId: string, prop: AnimProp, value: number, playhead = S().playhead): Project {
  const f = findItem(p, itemId)
  if (!f) return p
  const it = f.item
  const kfs = 'keyframes' in it ? it.keyframes[prop] : undefined
  if (kfs && kfs.length) return setKeyframe(p, itemId, prop, localTime(it, playhead), value)
  if (prop === 'volume') return updateItem(p, itemId, { volume: value } as Partial<Item>)
  if (prop === 'opacity') return updateItem(p, itemId, { opacity: value } as Partial<Item>)
  if ('transform' in it) return updateItem(p, itemId, { transform: { ...it.transform, [prop as VisualProp]: value } } as Partial<Item>)
  return p
}

// ---------- adding media ----------

function withTrack(p0: Project, kind: TrackKind, aboveIndex?: number): { p: Project; trackId: string } {
  const p = clone(p0)
  const t = insertTrack(p, kind, aboveIndex)
  return { p, trackId: t.id }
}

/**
 * Add an asset at time `at`. Visuals go to the main track unless `overlay` (a new overlay track on top, or
 * directly above stacking index `overlay.above`); audio goes to a free audio track.
 */
export function addAssetAt(asset: Asset, at: number, opts: { trackId?: string; overlay?: boolean | { above: number } } = {}): string | undefined {
  let p = S().project
  if (!p.assets[asset.id]) p = addAsset(p, asset)
  let item: Item
  if (asset.kind === 'video') item = createVideoItem(asset, at)
  else if (asset.kind === 'image') item = createImageItem(asset, at, { duration: 4 })
  else item = createAudioItem(asset, at)
  let trackId = opts.trackId
  if (!trackId && opts.overlay && asset.kind !== 'audio') {
    const r = withTrack(p, 'overlay', typeof opts.overlay === 'object' ? opts.overlay.above : undefined)
    p = r.p
    trackId = r.trackId
  }
  if (!trackId && asset.kind === 'audio') {
    const free = p.tracks.find((t) => t.kind === 'audio' && !t.locked && !t.items.some((i) => i.start < at + item.duration && itemEnd(i) > at))
    trackId = free?.id
  }
  p = addItem(p, item, trackId)
  S().commit(p, `Add ${asset.kind}`, { selection: [item.id] })
  return item.id
}

export function addText(templateId: string, at = S().playhead, over: Partial<Item> = {}) {
  const item = createTextItem(at, templateId, over as never)
  const p = addItem(S().project, item)
  S().commit(p, 'Add text', { selection: [item.id] })
  S().set({ activeRightTab: '', playing: false })
  // show the text fully (past its in-animation) so it's visible and selectable on the canvas
  const inDur = item.animations.in?.duration ?? 0
  if (inDur > 0) S().setPlayhead(at + Math.min(inDur + 0.02, item.duration / 2))
  return item.id
}

export function totalDuration() {
  return projectDuration(S().project)
}

// ---------- transport ----------

export function seek(t: number) {
  const d = totalDuration()
  S().setPlayhead(Math.max(0, Math.min(t, d)))
}

export function stepFrames(n: number) {
  const { playhead, project } = S()
  const f = Math.round(playhead * project.fps) + n
  seek(f / project.fps)
}

export function togglePlay() {
  const s = S()
  if (!s.playing && s.playhead >= totalDuration() - 1 / s.project.fps) s.setPlayhead(0)
  s.setPlaying(!s.playing)
}

export function demoBlocked(what = 'AI and export'): boolean {
  if (S().demo) {
    toast(`Sign in to use ${what} — the demo runs offline.`)
    return true
  }
  return false
}
