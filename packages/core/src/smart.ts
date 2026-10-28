// Server-made copies of a clip's media (E-21): stabilised, denoised, background removed. A copy may hold only part of
// the file (the part the clip shows, with a little either side), so swapping it in moves the clip's source offset by
// where the copy starts, then replaces the media as Replace media does (one undo step).
import { clone, findItem } from './ops'
import { replaceClipMedia, replaceRefusal } from './replace'
import type { AssetRecord } from './api'
import type { Asset, Item, Project } from './types'
import { EPS, round } from './util'

export type SmartTool = 'stabilise' | 'denoise' | 'removeBackground'

/** What this server can do (GET /api/smart-tools); null where it can't, with `why` for the person. */
export interface SmartToolsInfo {
  /** ffmpeg's stabiliser: two-pass vid.stab, or the simpler deshake. */
  stabilise: { method: 'vidstab' | 'deshake' } | null
  /** Sound: afftdn (spectral), arnndn (a speech model, when one is configured). Picture: hqdn3d (fast), nlmeans (strong). */
  denoise: { audio: Array<'afftdn' | 'arnndn'>; video: Array<'hqdn3d' | 'nlmeans'> }
  /** A background-removal command configured on the server (BG_REMOVAL_CMD). */
  removeBackground: { available: boolean }
  /** Why a tool is missing, by tool. */
  why: Partial<Record<SmartTool, string>>
}

export interface SmartJobRequest {
  /** Seconds into the file the copy must cover (the clip's part); the whole file when absent. */
  from?: number
  to?: number
  /** Denoise: which part, and how strongly (0..100). */
  target?: 'audio' | 'video'
  method?: string
  strength?: number
  /** Denoise a video file's sound into a sound file (for its separated sound clip). */
  soundOnly?: boolean
  /** Stabilise: 0..100, how much movement is smoothed out. */
  smoothing?: number
}

/** A finished smart job: the new copy and where in the original file it starts. */
export interface SmartJobResult {
  tool: SmartTool
  /** The copy, processed and ready (in the media library too). */
  asset: AssetRecord
  /** Seconds into the original file at the copy's 0. */
  offset: number
  sourceAssetId: string
}

/** The part of the file (seconds) a clip shows, with `handle` seconds either side for later trims. */
export function clipSourceRange(it: Item, handle = 1, fileDuration?: number): { from: number; to: number } | null {
  if (it.type !== 'video' && it.type !== 'audio') return null
  const a = it.in
  const b = it.type === 'video' && it.freezeAt !== undefined ? it.freezeAt : it.in + it.duration * it.speed
  const from = round(Math.max(0, Math.min(a, b) - handle), 3)
  let to = round(Math.max(a, b) + handle, 3)
  if (fileDuration !== undefined && fileDuration > 0) to = Math.min(to, fileDuration)
  return to - from > EPS ? { from, to } : null
}

/**
 * Put a processed copy in place of a clip's media: the source offset (and a freeze frame's time) moves back by where
 * the copy starts, then replaceClipMedia keeps everything else. Separated sound of the same file moves with it when
 * the copy has sound, as Replace media does.
 */
export function applyProcessedCopy(p0: Project, itemId: string, asset: Asset, offset: number): { project: Project; shortened?: boolean; refused?: ReturnType<typeof replaceRefusal> } {
  const why = replaceRefusal(p0, itemId, asset)
  if (why) return { project: p0, refused: why }
  const p = clone(p0)
  const f = findItem(p, itemId)!
  const it = f.item as Extract<Item, { assetId: string }>
  const shift = (x: Extract<Item, { assetId: string }>) => {
    if (x.type === 'image' || offset <= 0) return
    x.in = round(Math.max(0, x.in - offset), 4)
    if (x.type === 'video' && x.freezeAt !== undefined) x.freezeAt = round(Math.max(0, x.freezeAt - offset), 4)
  }
  const old = it.assetId
  shift(it)
  if (it.linkId && asset.hasAudio !== false)
    for (const t of p.tracks) for (const o of t.items) if (o !== it && o.linkId === it.linkId && o.type === 'audio' && o.assetId === old && !o.locked && !t.locked) shift(o)
  return replaceClipMedia(p, itemId, asset)
}
