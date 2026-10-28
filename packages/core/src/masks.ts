// Shape masks (E-21): a rectangle, an ellipse or a drawn path cut out of a clip's picture, with a soft edge, grown or
// shrunk, inverted, and keyframable. The mask is an SVG image used as the layer's CSS mask, so the preview and the
// export (headless Chrome running the same runtime) draw it alike. Its place and size are fractions of the clip's
// frame, so it moves, scales, turns and crops with the clip.
import { clone, editable, findItem, setKeyframe } from './ops'
import { cleanKey, type ChromaKey } from './key'
import type { ImageItem, Item, Project, VideoItem } from './types'
import { clamp, round, sampleKeyframes } from './util'

export type MaskShape = 'rect' | 'ellipse' | 'path'

export interface Mask {
  shape: MaskShape
  /** Centre, as fractions of the clip's frame (0..1; 0.5 is the middle). */
  x: number
  y: number
  /** Size, as fractions of the clip's frame. */
  width: number
  height: number
  /** Degrees, clockwise. */
  rotation: number
  /** A rectangle's rounded corners, 0..1 of its shorter half side. */
  radius: number
  /** Width of the soft edge, canvas px. */
  feather: number
  /** Grows (+) or shrinks (−) the shape, canvas px. */
  expand: number
  /** Keep what is outside the shape instead of inside. */
  invert: boolean
  /** A drawn path's corners in the mask's own box (−0.5..0.5 each way, before rotation), closed. */
  points?: Array<[number, number]>
}

/** Mask numbers that take keyframes (stored with the clip's other keyframes, so trims, splits and speed keep them). */
export type MaskProp = 'maskX' | 'maskY' | 'maskWidth' | 'maskHeight' | 'maskRotation' | 'maskFeather' | 'maskExpand'

export const MASK_PROPS: MaskProp[] = ['maskX', 'maskY', 'maskWidth', 'maskHeight', 'maskRotation', 'maskFeather', 'maskExpand']

const FIELD: Record<MaskProp, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'feather' | 'expand'> = {
  maskX: 'x',
  maskY: 'y',
  maskWidth: 'width',
  maskHeight: 'height',
  maskRotation: 'rotation',
  maskFeather: 'feather',
  maskExpand: 'expand',
}

export const MASK_LABELS: Record<MaskProp, string> = {
  maskX: 'Mask X',
  maskY: 'Mask Y',
  maskWidth: 'Mask width',
  maskHeight: 'Mask height',
  maskRotation: 'Mask rotation',
  maskFeather: 'Mask feather',
  maskExpand: 'Mask expansion',
}

export const isMaskProp = (p: string): p is MaskProp => p in FIELD

/** What the renderer draws for a layer's mask and key. */
export interface SmartLayer {
  /** CSS mask-image value (an SVG image the size of the layer box). */
  mask?: string
  key?: ChromaKey
}

type Pictured = VideoItem | ImageItem

export function takesMask(it: Item | undefined): it is Pictured {
  return it?.type === 'video' || it?.type === 'image'
}

export function defaultMask(shape: MaskShape): Mask {
  const m: Mask = { shape, x: 0.5, y: 0.5, width: 0.6, height: 0.6, rotation: 0, radius: 0, feather: 0, expand: 0, invert: false }
  if (shape === 'path') m.points = [[0, -0.5], [0.5, 0], [0, 0.5], [-0.5, 0]]
  return m
}

/** A path mask through `pts` (fractions of the clip's frame): its box is the points' bounds. */
export function pathMask(pts: Array<[number, number]>, base?: Mask): Mask | null {
  if (pts.length < 3) return null
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  const w = Math.max(0.01, x1 - x0)
  const h = Math.max(0.01, y1 - y0)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  return cleanMask({
    ...(base ?? defaultMask('path')),
    shape: 'path',
    x: cx,
    y: cy,
    width: w,
    height: h,
    rotation: 0,
    points: pts.map(([x, y]) => [(x - cx) / w, (y - cy) / h]),
  })
}

/** A mask with every number in range (what the document keeps). */
export function cleanMask(m: Mask): Mask {
  const num = (v: number, lo: number, hi: number, d: number, places = 4) => (Number.isFinite(v) ? round(clamp(v, lo, hi), places) : d)
  const out: Mask = {
    shape: m.shape === 'ellipse' || m.shape === 'path' ? m.shape : 'rect',
    x: num(m.x, -1, 2, 0.5),
    y: num(m.y, -1, 2, 0.5),
    width: num(m.width, 0.005, 4, 0.6),
    height: num(m.height, 0.005, 4, 0.6),
    rotation: num(m.rotation, -3600, 3600, 0, 2),
    radius: num(m.radius, 0, 1, 0, 3),
    feather: num(m.feather, 0, 500, 0, 1),
    expand: num(m.expand, -500, 500, 0, 1),
    invert: !!m.invert,
  }
  if (out.shape === 'path') {
    const pts = (m.points ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).slice(0, 200)
    out.points = pts.length >= 3 ? pts.map(([x, y]) => [round(clamp(x, -1, 1), 4), round(clamp(y, -1, 1), 4)]) : defaultMask('path').points
  }
  return out
}

/** The mask at `lt` seconds into the clip, keyframes applied. */
export function maskAt(it: Pictured, lt: number): Mask | undefined {
  const m = it.mask
  if (!m) return undefined
  const out = { ...m }
  for (const prop of MASK_PROPS) out[FIELD[prop]] = sampleKeyframes(it.keyframes?.[prop], lt, m[FIELD[prop]])
  out.width = Math.max(0.005, out.width)
  out.height = Math.max(0.005, out.height)
  out.feather = Math.max(0, out.feather)
  return out
}

export function readMaskProp(it: Item, prop: MaskProp, lt: number): number {
  if (!takesMask(it) || !it.mask) return 0
  return sampleKeyframes(it.keyframes?.[prop], lt, it.mask[FIELD[prop]])
}

/** Set a mask number; when it has keyframes, the keyframe at `lt` (seconds into the clip) instead. */
export function writeMaskProp(p0: Project, itemId: string, prop: MaskProp, value: number, lt: number): Project {
  const f = findItem(p0, itemId)
  if (!editable(f) || !takesMask(f.item) || !f.item.mask) return p0
  if (f.item.keyframes?.[prop]?.length) return setKeyframe(p0, itemId, prop, lt, value)
  return setMask(p0, itemId, { ...f.item.mask, [FIELD[prop]]: value })
}

/** Several mask numbers at once (a drag on the canvas), each keyframe-aware. */
export function writeMaskProps(p0: Project, itemId: string, values: Partial<Record<MaskProp, number>>, lt: number): Project {
  let p = p0
  for (const [prop, v] of Object.entries(values) as Array<[MaskProp, number]>) p = writeMaskProp(p, itemId, prop, v, lt)
  return p
}

/** Give a clip a mask, change it, or take it off (`undefined`, which drops its keyframes too). */
export function setMask(p0: Project, itemId: string, mask: Mask | undefined): Project {
  const p = clone(p0)
  const f = findItem(p, itemId)
  if (!editable(f) || !takesMask(f.item)) return p0
  if (mask) f.item.mask = cleanMask(mask)
  else {
    delete f.item.mask
    for (const prop of MASK_PROPS) delete f.item.keyframes?.[prop]
  }
  p.updatedAt = Date.now()
  return p
}

/** Turn a clip's chroma key on, change it, or take it off. */
export function setChromaKey(p0: Project, itemId: string, key: Partial<ChromaKey> | undefined): Project {
  const p = clone(p0)
  const f = findItem(p, itemId)
  if (!editable(f) || !takesMask(f.item)) return p0
  if (key) f.item.chromaKey = cleanKey({ ...f.item.chromaKey, ...key })
  else delete f.item.chromaKey
  p.updatedAt = Date.now()
  return p
}

const n = (v: number) => String(round(v, 2))

/** The shape's outline in the mask's own coordinates (px, centred on 0,0, before rotation). */
function shapeMarkup(m: Mask, w: number, h: number, paint: string): string {
  if (m.shape === 'ellipse') return `<ellipse cx='0' cy='0' rx='${n(w / 2)}' ry='${n(h / 2)}' ${paint}/>`
  if (m.shape === 'path') {
    const pts = m.points ?? []
    return `<path d='${pts.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x * w)} ${n(y * h)}`).join(' ')} Z' ${paint}/>`
  }
  const r = m.radius * Math.min(w, h) * 0.5
  return `<rect x='${n(-w / 2)}' y='${n(-h / 2)}' width='${n(w)}' height='${n(h)}'${r > 0 ? ` rx='${n(r)}'` : ''} ${paint}/>`
}

/**
 * The CSS mask-image for a mask on a layer box of boxW × boxH canvas px: white where the picture shows. The SVG draws
 * the shape inside an SVG <mask> (luminance), blurred for the feather, stroked to grow or shrink it.
 */
export function maskImage(m: Mask, boxW: number, boxH: number): string {
  const W = Math.max(1, boxW)
  const H = Math.max(1, boxH)
  const w = m.width * W
  const h = m.height * H
  const fg = m.invert ? 'black' : 'white'
  const bg = m.invert ? 'white' : 'black'
  const e = m.expand
  const stroke = Math.abs(e) > 0.01 ? ` stroke='${e > 0 ? fg : bg}' stroke-width='${n(Math.abs(e) * 2)}' stroke-linejoin='round'` : ''
  const paint = `fill='${fg}'${stroke}`
  const area = `x='${n(-W)}' y='${n(-H)}' width='${n(3 * W)}' height='${n(3 * H)}'`
  const blur = m.feather > 0.05 ? `<filter id='f' filterUnits='userSpaceOnUse' ${area}><feGaussianBlur stdDeviation='${n(m.feather / 2)}'/></filter>` : ''
  const body =
    (m.invert ? `<rect ${area} fill='white'/>` : '') +
    `<g transform='translate(${n(m.x * W)} ${n(m.y * H)}) rotate(${n(m.rotation)})'>${shapeMarkup(m, w, h, paint)}</g>`
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${n(W)}' height='${n(H)}' viewBox='0 0 ${n(W)} ${n(H)}'>` +
    `<defs>${blur}<mask id='m' maskUnits='userSpaceOnUse' ${area}><g${blur ? ` filter='url(#f)'` : ''}>${body}</g></mask></defs>` +
    `<rect width='${n(W)}' height='${n(H)}' fill='white' mask='url(#m)'/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/** A clip's mask and key at `lt` seconds into it, for its layer (evaluate). */
export function smartLayer(it: Item, lt: number, box: { width: number; height: number }): SmartLayer | undefined {
  if (!takesMask(it) || (!it.mask && !it.chromaKey)) return undefined
  const out: SmartLayer = {}
  const m = maskAt(it, lt)
  if (m) out.mask = maskImage(m, box.width, box.height)
  if (it.chromaKey) out.key = cleanKey(it.chromaKey)
  return out
}
