// Replace a clip's media keeping everything else about it, and split a clip where its picture changes (E-10). The
// scene changes come from the server (media.scenes, ffmpeg's scene score) as times in the clip's file.
import { clone, findItem, itemEnd, packMain, splitItem } from './ops'
import { clipLocalAt, localAtOffset, sourceRange, syncAverageSpeed } from './speed'
import type { Asset, Item, Project } from './types'
import { EPS, clamp, round } from './util'

export type ReplaceRefusal = 'missing' | 'locked' | 'kind' | 'same'

/** Why `asset` can't replace the media of `itemId` (null when it can). */
export function replaceRefusal(p: Project, itemId: string, asset: Pick<Asset, 'id' | 'kind'>): ReplaceRefusal | null {
  const f = findItem(p, itemId)
  if (!f || !('assetId' in f.item)) return 'missing'
  if (f.item.locked || f.track.locked) return 'locked'
  if (f.item.type !== asset.kind) return 'kind'
  if (f.item.assetId === asset.id) return 'same'
  return null
}

/**
 * Swap a clip's media for `asset`, keeping its place, length, effects, keyframes, transitions and look. The source
 * offset stays where it was when the new file is long enough, else moves back so the clip still fits; a file shorter
 * than the clip shortens it (`shortened`). Separated audio of the same old file follows, when the new one has sound.
 */
export function replaceClipMedia(p0: Project, itemId: string, asset: Asset): { project: Project; shortened?: boolean } {
  if (replaceRefusal(p0, itemId, asset)) return { project: p0 }
  const p = clone(p0)
  p.assets[asset.id] = asset
  const f = findItem(p, itemId)!
  const it = f.item as Extract<Item, { assetId: string }>
  const old = it.assetId
  const oldName = p0.assets[old]?.name
  let shortened = false
  const swap = (x: Extract<Item, { assetId: string }>) => {
    x.assetId = asset.id
    if (!x.name || x.name === oldName) x.name = asset.name
    if (x.type === 'image') return
    const max = asset.duration
    if (x.type === 'audio') x.tts = undefined
    if (x.type === 'video' && x.freezeAt !== undefined) {
      if (max !== undefined) x.freezeAt = round(clamp(x.freezeAt, 0, Math.max(0, max - 0.05)), 4)
      return
    }
    if (max === undefined) return
    const need = sourceRange(x).end - x.in
    if (x.in + need > max + EPS) x.in = round(Math.max(0, max - need), 4)
    if (need > max + EPS) {
      // the whole new file, along the clip's speed ramp if it has one
      x.duration = round(localAtOffset(x, max), 4)
      syncAverageSpeed(x)
      shortened = true
    }
  }
  swap(it)
  if (it.linkId && asset.hasAudio !== false)
    for (const t of p.tracks) for (const o of t.items) if (o !== it && o.linkId === it.linkId && o.type === 'audio' && o.assetId === old && !o.locked && !t.locked) swap(o)
  if (shortened) packMain(p)
  p.updatedAt = Date.now()
  return { project: p, shortened }
}

/** Timeline time at which a clip shows source time `src` (undefined when it never does). */
export function timelineAtSource(it: Item, src: number): number | undefined {
  if (it.type !== 'video' && it.type !== 'audio') return undefined
  if (it.type === 'video' && it.freezeAt !== undefined) return undefined
  const local = clipLocalAt(it, src)
  return local > EPS && local < it.duration - EPS ? round(it.start + local, 4) : undefined
}

/**
 * Split a clip at the scene changes found in its source (`cuts`, seconds into the file), leaving no piece shorter
 * than `minPiece`. Returns the new project and how many cuts were made.
 */
export function splitAtSourceTimes(p0: Project, itemId: string, cuts: number[], minPiece = 0.25): { project: Project; count: number } {
  const it = findItem(p0, itemId)?.item
  if (!it) return { project: p0, count: 0 }
  const times = cuts
    .map((c) => timelineAtSource(it, c))
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => a - b)
  let p = p0
  let id = itemId
  let last = it.start
  let count = 0
  for (const t of times) {
    if (t - last < minPiece || itemEnd(it) - t < minPiece) continue
    const r = splitItem(p, id, t)
    if (!r.rightId) continue
    p = r.project
    id = r.rightId
    last = t
    count++
  }
  return { project: p, count }
}
