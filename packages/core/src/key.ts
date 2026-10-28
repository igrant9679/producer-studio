// Chroma key (E-21): a colour of a clip turned transparent. It is drawn by an SVG filter on the clip's picture, which
// the preview and the export (headless Chrome) both run, so both key alike. keyPixel() is the same arithmetic in
// script, for tests and for anything that needs to know what the filter does to one colour.
import { clamp, round } from './util'

export interface ChromaKey {
  /** The colour taken out, #rrggbb. */
  color: string
  /** 0..100: how far from the colour still counts as it. */
  tolerance: number
  /** 0..100: how wide the soft edge between keyed and kept is. */
  softness: number
  /** 0..100: how much of the key colour's tint is taken off what remains (green fringes on hair and skin). */
  spill: number
}

export const DEFAULT_KEY: ChromaKey = { color: '#00b140', tolerance: 35, softness: 20, spill: 50 }

/** Green and blue screen colours offered next to the eyedropper. */
export const KEY_PRESETS: Array<{ name: string; color: string }> = [
  { name: 'Green screen', color: '#00b140' },
  { name: 'Blue screen', color: '#0047bb' },
]

/** A key with every number in range and a usable colour. */
export function cleanKey(k: Partial<ChromaKey>): ChromaKey {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? round(clamp(v, 0, 100), 2) : d)
  const color = typeof k.color === 'string' && /^#[0-9a-f]{6}$/i.test(k.color) ? k.color.toLowerCase() : DEFAULT_KEY.color
  return { color, tolerance: n(k.tolerance, DEFAULT_KEY.tolerance), softness: n(k.softness, DEFAULT_KEY.softness), spill: n(k.spill, DEFAULT_KEY.spill) }
}

function rgbOf(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  const v = m ? parseInt(m[1], 16) : 0x00b140
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

// BT.601 chroma of an sRGB colour (0..1 in, -0.5..0.5 out): brightness doesn't move it, so shadows on the screen key too
const CB = [-0.168736, -0.331264, 0.5]
const CR = [0.5, -0.418688, -0.081312]
const dot = (a: number[], r: number, g: number, b: number) => a[0] * r + a[1] * g + a[2] * b

/** #rrggbb from 0..255 channels. */
export function hexColor(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** What the filter is built from: the key's chroma, its scale, the soft edge, the spill weights. */
export function keyParams(k0: ChromaKey) {
  const k = cleanKey(k0)
  const [r, g, b] = rgbOf(k.color)
  const kb = dot(CB, r, g, b)
  const kr = dot(CR, r, g, b)
  // distance (|ΔCb| + |ΔCr|) where the key ends and where the edge is fully kept
  const inner = (k.tolerance / 100) * 0.6
  const outer = inner + 0.005 + (k.softness / 100) * 0.4
  // the filter works in 8 bits: the distance is scaled so the edge spans the whole range
  const scale = 1 / outer
  const edge = inner * scale
  // spill: the part of a colour's chroma that points the key's way is taken off. Lowering only the channels that
  // direction raises (green for a green screen) keeps it to one clamp-safe step.
  const len = Math.hypot(kb, kr) || 1
  const ub = kb / len
  const ur = kr / len
  const a = k.spill / 100
  // channel change per unit of chroma removed along (ub, ur), luma kept: R = Y + 1.402 Cr, G = Y − 0.344 Cb − 0.714 Cr, B = Y + 1.772 Cb
  const v = [1.402 * ur, -0.344136 * ub - 0.714136 * ur, 1.772 * ub].map((x) => Math.max(0, x) * a)
  const proj = [0, 1, 2].map((i) => ub * CB[i] + ur * CR[i])
  return { kb, kr, scale, edge, spill: a > 0 && len > 0.02 ? { v, proj } : undefined }
}

const smooth = (e0: number, x: number) => {
  if (e0 >= 1) return x >= 1 ? 1 : 0
  const t = clamp((x - e0) / (1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Entries of the transfer table that turns the scaled distance into the matte's alpha. */
const TABLE = 32

/** The matte's alpha table (0 inside the key, 1 outside it, smooth between). */
export function keyTable(k: ChromaKey): number[] {
  const { edge } = keyParams(k)
  return Array.from({ length: TABLE + 1 }, (_, i) => round(smooth(edge, i / TABLE), 4))
}

const c8 = (v: number) => Math.round(clamp(v, 0, 1) * 255) / 255
const f = (v: number) => String(round(v, 5))

/**
 * The <filter> element (sRGB, its own id) that keys `k`. Steps: the chroma distance from the key, split into
 * clamp-safe positive parts and summed into alpha; the alpha table; spill taken off the picture; picture × matte.
 */
export function keyFilterMarkup(id: string, k: ChromaKey): string {
  const { kb, kr, scale: s, spill } = keyParams(k)
  const row = (c: number[], o: number) => `${c.map(f).join(' ')} 0 ${f(o)}`
  const zero = '0 0 0 0 0'
  const one = '0 0 0 0 1'
  const d1 = [row(CB.map((x) => x * s), -kb * s), row(CB.map((x) => -x * s), kb * s), row(CR.map((x) => x * s), -kr * s), one].join('  ')
  const d2 = [zero, zero, row(CR.map((x) => -x * s), kr * s), one].join('  ')
  const parts = [
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${d1}" result="d1"/>`,
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${d2}" result="d2"/>`,
    `<feComposite in="d1" in2="d2" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="d"/>`,
    `<feColorMatrix in="d" type="matrix" values="${[zero, zero, zero, '1 1 1 0 0'].join('  ')}" result="dist"/>`,
    `<feComponentTransfer in="dist" result="matte"><feFuncA type="table" tableValues="${keyTable(k).join(' ')}"/></feComponentTransfer>`,
  ]
  let pic = 'SourceGraphic'
  if (spill) {
    // n = 1 − v·max(0, p) per channel (the clamp at 1 is the max), then picture + n − 1
    const n = [0, 1, 2].map((i) => row(spill.proj.map((x) => -x * spill.v[i]), 1)).concat(one).join('  ')
    parts.push(`<feColorMatrix in="SourceGraphic" type="matrix" values="${n}" result="n"/>`)
    parts.push(`<feComposite in="SourceGraphic" in2="n" operator="arithmetic" k1="0" k2="1" k3="1" k4="-1" result="clean"/>`)
    pic = 'clean'
  }
  parts.push(`<feComposite in="${pic}" in2="matte" operator="in"/>`)
  return `<filter id="${id}" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">${parts.join('')}</filter>`
}

/**
 * What the key filter makes of one opaque colour (0..255 in and out, alpha 0..1), step for step with the same clamps
 * and 8-bit rounding of each intermediate.
 */
export function keyPixel(r255: number, g255: number, b255: number, k: ChromaKey): { r: number; g: number; b: number; a: number } {
  const { kb, kr, scale: s, spill } = keyParams(k)
  const r = r255 / 255
  const g = g255 / 255
  const b = b255 / 255
  const cb = dot(CB, r, g, b)
  const cr = dot(CR, r, g, b)
  const d1 = [c8((cb - kb) * s), c8(-(cb - kb) * s), c8((cr - kr) * s)]
  const d2 = c8(-(cr - kr) * s)
  const dist = c8(d1[0] + d1[1] + c8(d1[2] + d2))
  const table = keyTable(k)
  const pos = dist * TABLE
  const i = Math.min(TABLE - 1, Math.floor(pos))
  const a = c8(table[i] + (table[i + 1] - table[i]) * (pos - i))
  let out = [r, g, b]
  if (spill) {
    const p = dot(spill.proj, r, g, b)
    out = out.map((c, ch) => c8(c + c8(1 - spill.v[ch] * p) - 1))
  }
  return { r: Math.round(out[0] * 255), g: Math.round(out[1] * 255), b: Math.round(out[2] * 255), a }
}
