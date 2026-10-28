// Colour grading: tone curves, HSL by hue range and 3D LUTs (.cube files), plus adjustment layers. The pixel maths
// here is what the runtime's WebGL shader does step for step (gradeRuntime.ts): its CPU fallback and the tests call
// these functions, so the preview, the export and the scopes all draw the same pixels.
import { clone, insertTrack, projectDuration } from './ops'
import { FILTERS, NEUTRAL_ADJUST } from './presets'
import type { AdjustmentItem, ColorAdjust, Curves, CurvePoints, FrameLayer, Grade, HslShift, HueRange, Lut, Project, Track } from './types'
import { clamp, round, sampleKeyframes, uid } from './util'

export const HUE_RANGES: Array<{ id: HueRange; name: string; hue: number; swatch: string }> = [
  { id: 'red', name: 'Red', hue: 0, swatch: '#e5484d' },
  { id: 'orange', name: 'Orange', hue: 30, swatch: '#f76b15' },
  { id: 'yellow', name: 'Yellow', hue: 60, swatch: '#ffe629' },
  { id: 'green', name: 'Green', hue: 120, swatch: '#30a46c' },
  { id: 'aqua', name: 'Aqua', hue: 180, swatch: '#12a594' },
  { id: 'blue', name: 'Blue', hue: 240, swatch: '#3e63dd' },
  { id: 'purple', name: 'Purple', hue: 270, swatch: '#8e4ec6' },
  { id: 'magenta', name: 'Magenta', hue: 300, swatch: '#d6409f' },
]

/** Hue shift at ±100, in degrees. */
export const HSL_HUE_DEG = 30
/** LUTs are kept at most this many points per side (larger ones are resampled), so a project stays small. */
export const LUT_MAX_SIZE = 33

// ---------- the CSS part: basic colour adjustments and filter presets ----------

export function adjustToFilter(adjust: ColorAdjust | undefined, filterId?: string, intensity = 100): { filter: string; vignette: number } {
  const a: ColorAdjust = { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, tint: 0, hue: 0, sharpen: 0, vignette: 0, ...(adjust ?? {}) }
  let sepia = 0
  let gray = 0
  if (filterId) {
    const f = FILTERS.find((x) => x.id === filterId)
    if (f) {
      const k = intensity / 100
      for (const [key, v] of Object.entries(f.adjust)) a[key as keyof ColorAdjust] += (v as number) * k
      sepia += (f.sepia ?? 0) * k
      gray += (f.grayscale ?? 0) * k
    }
  }
  const parts: string[] = []
  const bright = (1 + a.brightness / 200) * 2 ** (a.exposure / 100)
  if (Math.abs(bright - 1) > 0.001) parts.push(`brightness(${bright.toFixed(3)})`)
  const contrast = 1 + a.contrast / 100 + a.sharpen / 400
  if (Math.abs(contrast - 1) > 0.001) parts.push(`contrast(${contrast.toFixed(3)})`)
  const sat = 1 + a.saturation / 100
  if (Math.abs(sat - 1) > 0.001) parts.push(`saturate(${Math.max(0, sat).toFixed(3)})`)
  if (a.temperature > 0) sepia += a.temperature * 0.35
  const hue = a.hue * 1.8 + (a.temperature < 0 ? a.temperature * 0.25 : 0) + a.tint * 0.4
  if (sepia > 0) parts.push(`sepia(${clamp(sepia / 100, 0, 1).toFixed(3)})`)
  if (gray > 0) parts.push(`grayscale(${clamp(gray / 100, 0, 1).toFixed(3)})`)
  if (Math.abs(hue) > 0.01) parts.push(`hue-rotate(${hue.toFixed(2)}deg)`)
  return { filter: parts.join(' '), vignette: a.vignette }
}

// ---------- curves ----------

const straight = (pts: CurvePoints | undefined) => !pts || pts.length < 2 || pts.every(([x, y]) => Math.abs(x - y) < 1e-4)

/** Sorted, clamped curve points with one point per input (the last of equal inputs wins). */
export function cleanCurve(pts: CurvePoints): CurvePoints {
  const out: CurvePoints = []
  for (const [x, y] of [...pts].filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).sort((a, b) => a[0] - b[0])) {
    const px = clamp(x, 0, 1)
    const py = clamp(y, 0, 1)
    if (out.length && Math.abs(out[out.length - 1][0] - px) < 1e-4) out[out.length - 1] = [px, py]
    else out.push([px, py])
  }
  return out
}

/**
 * The curve through `pts` at `x`: monotone cubic (Fritsch–Carlson), so it never overshoots between points; flat
 * before the first point and after the last.
 */
export function evalCurve(pts: CurvePoints | undefined, x: number): number {
  if (straight(pts)) return clamp(x, 0, 1)
  const p = cleanCurve(pts!)
  if (p.length < 2) return clamp(x, 0, 1)
  const n = p.length
  if (x <= p[0][0]) return p[0][1]
  if (x >= p[n - 1][0]) return p[n - 1][1]
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]))
  const m: number[] = [d[0]]
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)
  m.push(d[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0
      continue
    }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const s = a * a + b * b
    if (s > 9) {
      const t = 3 / Math.sqrt(s)
      m[i] = t * a * d[i]
      m[i + 1] = t * b * d[i]
    }
  }
  let i = 0
  while (i < n - 2 && x > p[i + 1][0]) i++
  const h = p[i + 1][0] - p[i][0]
  const t = (x - p[i][0]) / h
  const t2 = t * t
  const t3 = t2 * t
  const y = (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1]
  return clamp(y, 0, 1)
}

export function curvesNeutral(c: Curves | undefined): boolean {
  return !c || (straight(c.master) && straight(c.r) && straight(c.g) && straight(c.b))
}

/**
 * The curves as one lookup table: 256 RGBA entries, entry i holding each channel's curve of the master curve of i/255.
 * The shader reads it as a 256×1 texture with linear filtering, so a value between entries is interpolated.
 */
export function curvesTable(c: Curves): Uint8Array {
  const out = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const m = evalCurve(c.master, i / 255)
    out[i * 4] = Math.round(evalCurve(c.r, m) * 255)
    out[i * 4 + 1] = Math.round(evalCurve(c.g, m) * 255)
    out[i * 4 + 2] = Math.round(evalCurve(c.b, m) * 255)
    out[i * 4 + 3] = 255
  }
  return out
}

function tableAt(table: Uint8Array, ch: number, v: number): number {
  const f = clamp(v, 0, 1) * 255
  const i = Math.floor(f)
  const j = Math.min(255, i + 1)
  const t = f - i
  return (table[i * 4 + ch] * (1 - t) + table[j * 4 + ch] * t) / 255
}

// ---------- HSL ----------

export function hslNeutral(h: Grade['hsl']): boolean {
  return !h || Object.values(h).every((x) => !x || (Math.abs(x.h) < 0.01 && Math.abs(x.s) < 0.01 && Math.abs(x.l) < 0.01))
}

/** The eight ranges' shifts in HUE_RANGES order, as 24 numbers (h, s, l of each) for the shader. */
export function hslVector(h: Grade['hsl']): Float32Array {
  const out = new Float32Array(24)
  HUE_RANGES.forEach((r, i) => {
    const s: HslShift | undefined = h?.[r.id]
    out[i * 3] = clamp(s?.h ?? 0, -100, 100)
    out[i * 3 + 1] = clamp(s?.s ?? 0, -100, 100)
    out[i * 3 + 2] = clamp(s?.l ?? 0, -100, 100)
  })
  return out
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d < 1e-6) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h * 60, s, l]
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s < 1e-6) return [l, l, l]
  const hh = (((h % 360) + 360) % 360) / 360
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hue2rgb(p, q, hh + 1 / 3), hue2rgb(p, q, hh), hue2rgb(p, q, hh - 1 / 3)]
}

/**
 * How much of each hue range a hue (degrees) takes: the two ranges either side of it, in proportion to how near it
 * is to each one's centre (always summing to 1).
 */
export function hueWeights(hue: number): Array<[number, number]> {
  const h = ((hue % 360) + 360) % 360
  for (let i = 0; i < 8; i++) {
    const a = HUE_RANGES[i].hue
    const b = i === 7 ? 360 : HUE_RANGES[i + 1].hue
    if (h >= a && h < b) {
      const t = (h - a) / (b - a)
      return [[i, 1 - t], [(i + 1) % 8, t]]
    }
  }
  return [[0, 1]]
}

/** One pixel (0..1 channels) through the HSL adjustment. Grey pixels stay as they are. */
export function applyHsl(r: number, g: number, b: number, v: Float32Array): [number, number, number] {
  const [h, s, l] = rgbToHsl(r, g, b)
  const chroma = Math.max(r, g, b) - Math.min(r, g, b)
  const k = Math.min(1, chroma * 5)
  if (k <= 0) return [r, g, b]
  let dh = 0
  let ds = 0
  let dl = 0
  for (const [i, w] of hueWeights(h)) {
    dh += v[i * 3] * w
    ds += v[i * 3 + 1] * w
    dl += v[i * 3 + 2] * w
  }
  dh = (dh / 100) * k
  ds = (ds / 100) * k
  dl = (dl / 100) * k
  const h2 = h + dh * HSL_HUE_DEG
  const s2 = clamp(s * (1 + ds), 0, 1)
  const l2 = clamp(dl >= 0 ? l + (1 - l) * dl * 0.6 : l * (1 + dl * 0.6), 0, 1)
  return hslToRgb(h2, s2, l2)
}

// ---------- LUTs ----------

export interface LutData {
  size: number
  /** size³ RGB bytes, red fastest. */
  data: Uint8Array
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function encodeLut(d: LutData): string {
  return toBase64(d.data)
}

const decoded = new Map<string, LutData | null>()

/** A project LUT's samples, or null when its data is damaged. */
export function decodeLut(lut: Pick<Lut, 'id' | 'size' | 'data'>): LutData | null {
  const key = `${lut.id}:${lut.size}:${lut.data.length}:${lut.data.slice(0, 32)}:${lut.data.slice(-32)}`
  if (decoded.has(key)) return decoded.get(key)!
  let out: LutData | null = null
  try {
    const data = fromBase64(lut.data)
    if (lut.size >= 2 && lut.size <= LUT_MAX_SIZE && data.length === lut.size ** 3 * 3) out = { size: lut.size, data }
  } catch {
    out = null
  }
  if (decoded.size > 32) decoded.clear()
  decoded.set(key, out)
  return out
}

/** The LUT at (r, g, b) in 0..1, trilinear between its points (the shader fetches the same eight points). */
export function sampleLut(lut: LutData, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size
  const f = [clamp(r, 0, 1) * (n - 1), clamp(g, 0, 1) * (n - 1), clamp(b, 0, 1) * (n - 1)]
  const i0 = f.map(Math.floor)
  const i1 = i0.map((v) => Math.min(n - 1, v + 1))
  const t = f.map((v, k) => v - i0[k])
  const at = (ri: number, gi: number, bi: number, c: number) => lut.data[((bi * n + gi) * n + ri) * 3 + c] / 255
  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const c00 = at(i0[0], i0[1], i0[2], c) * (1 - t[0]) + at(i1[0], i0[1], i0[2], c) * t[0]
    const c10 = at(i0[0], i1[1], i0[2], c) * (1 - t[0]) + at(i1[0], i1[1], i0[2], c) * t[0]
    const c01 = at(i0[0], i0[1], i1[2], c) * (1 - t[0]) + at(i1[0], i0[1], i1[2], c) * t[0]
    const c11 = at(i0[0], i1[1], i1[2], c) * (1 - t[0]) + at(i1[0], i1[1], i1[2], c) * t[0]
    const c0 = c00 * (1 - t[1]) + c10 * t[1]
    const c1 = c01 * (1 - t[1]) + c11 * t[1]
    out[c] = c0 * (1 - t[2]) + c1 * t[2]
  }
  return out
}

export class CubeError extends Error {}

/**
 * Read a .cube file (Adobe / Resolve): a 3D LUT (LUT_3D_SIZE), or a 1D one (LUT_1D_SIZE, made into a 3D one), with
 * an optional input domain. A LUT larger than LUT_MAX_SIZE points a side is resampled to that size.
 */
export function parseCube(text: string): { title?: string; lut: LutData } {
  let title: string | undefined
  let size3 = 0
  let size1 = 0
  let min = [0, 0, 0]
  let max = [1, 1, 1]
  const rows: number[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const word = parts[0].toUpperCase()
    if (word === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '') || undefined
    else if (word === 'LUT_3D_SIZE') size3 = Number(parts[1])
    else if (word === 'LUT_1D_SIZE') size1 = Number(parts[1])
    else if (word === 'DOMAIN_MIN') min = parts.slice(1, 4).map(Number)
    else if (word === 'DOMAIN_MAX') max = parts.slice(1, 4).map(Number)
    else if (word === 'LUT_1D_INPUT_RANGE' || word === 'LUT_3D_INPUT_RANGE') {
      const [lo, hi] = parts.slice(1, 3).map(Number)
      min = [lo, lo, lo]
      max = [hi, hi, hi]
    } else if (/^[-+.\d]/.test(word)) {
      if (parts.length < 3) throw new CubeError('This .cube file has a line that is not three numbers.')
      const r = Number(parts[0])
      const g = Number(parts[1])
      const b = Number(parts[2])
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) throw new CubeError('This .cube file has a line that is not three numbers.')
      rows.push(r, g, b)
    }
  }
  if (min.length < 3 || max.length < 3 || [...min, ...max].some((x) => !Number.isFinite(x)) || max.some((x, i) => x <= min[i])) throw new CubeError('This .cube file has a broken DOMAIN_MIN / DOMAIN_MAX.')
  const src = (n: number) => ({ n, v: (i: number) => rows[i] })
  if (size3) {
    if (!Number.isInteger(size3) || size3 < 2 || size3 > 256) throw new CubeError(`LUT_3D_SIZE ${size3} is not a size this editor can read (2 to 256).`)
    if (rows.length !== size3 ** 3 * 3) throw new CubeError(`This .cube file should have ${size3 ** 3} entries but has ${Math.floor(rows.length / 3)}.`)
    const s = src(size3)
    const at = (ri: number, gi: number, bi: number, c: number) => s.v(((bi * size3 + gi) * size3 + ri) * 3 + c)
    return { title, lut: resample(Math.min(size3, LUT_MAX_SIZE), min, max, (r, g, b) => trilinear(size3, at, r, g, b)) }
  }
  if (size1) {
    if (!Number.isInteger(size1) || size1 < 2 || size1 > 65536) throw new CubeError(`LUT_1D_SIZE ${size1} is not a size this editor can read.`)
    if (rows.length !== size1 * 3) throw new CubeError(`This .cube file should have ${size1} entries but has ${Math.floor(rows.length / 3)}.`)
    const one = (x: number, c: number) => {
      const f = clamp(x, 0, 1) * (size1 - 1)
      const i = Math.floor(f)
      const j = Math.min(size1 - 1, i + 1)
      return rows[i * 3 + c] * (1 - (f - i)) + rows[j * 3 + c] * (f - i)
    }
    return { title, lut: resample(LUT_MAX_SIZE, min, max, (r, g, b) => [one(r, 0), one(g, 1), one(b, 2)]) }
  }
  throw new CubeError('This is not a .cube LUT: it has no LUT_3D_SIZE or LUT_1D_SIZE line.')
}

function trilinear(n: number, at: (r: number, g: number, b: number, c: number) => number, r: number, g: number, b: number): number[] {
  const f = [clamp(r, 0, 1) * (n - 1), clamp(g, 0, 1) * (n - 1), clamp(b, 0, 1) * (n - 1)]
  const i0 = f.map(Math.floor)
  const i1 = i0.map((v) => Math.min(n - 1, v + 1))
  const t = f.map((v, k) => v - i0[k])
  const out = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const x00 = at(i0[0], i0[1], i0[2], c) * (1 - t[0]) + at(i1[0], i0[1], i0[2], c) * t[0]
    const x10 = at(i0[0], i1[1], i0[2], c) * (1 - t[0]) + at(i1[0], i1[1], i0[2], c) * t[0]
    const x01 = at(i0[0], i0[1], i1[2], c) * (1 - t[0]) + at(i1[0], i0[1], i1[2], c) * t[0]
    const x11 = at(i0[0], i1[1], i1[2], c) * (1 - t[0]) + at(i1[0], i1[1], i1[2], c) * t[0]
    out[c] = (x00 * (1 - t[1]) + x10 * t[1]) * (1 - t[2]) + (x01 * (1 - t[1]) + x11 * t[1]) * t[2]
  }
  return out
}

/** A size³ grid over 0..1 inputs, each looked up in the source through its domain, as bytes. */
function resample(size: number, min: number[], max: number[], f: (r: number, g: number, b: number) => number[]): LutData {
  const data = new Uint8Array(size ** 3 * 3)
  let o = 0
  const dom = (v: number, c: number) => (v - min[c]) / (max[c] - min[c])
  for (let bi = 0; bi < size; bi++)
    for (let gi = 0; gi < size; gi++)
      for (let ri = 0; ri < size; ri++) {
        const v = f(dom(ri / (size - 1), 0), dom(gi / (size - 1), 1), dom(bi / (size - 1), 2))
        for (let c = 0; c < 3; c++) data[o++] = Math.round(clamp(v[c], 0, 1) * 255)
      }
  return { size, data }
}

// ---------- a whole grade ----------

export function gradeNeutral(g: Grade | undefined, luts?: Project['luts']): boolean {
  if (!g) return true
  const lut = g.lut && g.lut.intensity > 0 && luts?.[g.lut.id]
  return curvesNeutral(g.curves) && hslNeutral(g.hsl) && !lut
}

/** A grade ready to draw: the lookup tables the shader takes as textures and uniforms. */
export interface PreparedGrade {
  key: string
  curves: Uint8Array | null
  hsl: Float32Array | null
  lut: (LutData & { id: string }) | null
  /** 0..1 */
  lutMix: number
}

const prepared = new Map<string, PreparedGrade>()

export function prepareGrade(g: Grade, luts?: Project['luts']): PreparedGrade {
  const lutDoc = g.lut && g.lut.intensity > 0 ? luts?.[g.lut.id] : undefined
  const key = JSON.stringify([g.curves ?? null, g.hsl ?? null, lutDoc ? [lutDoc.id, lutDoc.size, lutDoc.data.length] : null, g.lut?.intensity ?? 0])
  const hit = prepared.get(key)
  if (hit) return hit
  const lut = lutDoc ? decodeLut(lutDoc) : null
  const out: PreparedGrade = {
    key,
    curves: curvesNeutral(g.curves) ? null : curvesTable(g.curves!),
    hsl: hslNeutral(g.hsl) ? null : hslVector(g.hsl),
    lut: lut ? { ...lut, id: lutDoc!.id } : null,
    lutMix: lut ? clamp((g.lut?.intensity ?? 0) / 100, 0, 1) : 0,
  }
  if (prepared.size > 64) prepared.clear()
  prepared.set(key, out)
  return out
}

/** One pixel (0..255 channels) through a grade, mixed in at `mix`: what the shader computes, before rounding. */
export function gradePixel(g: PreparedGrade, mix: number, r8: number, g8: number, b8: number): [number, number, number] {
  let r = r8 / 255
  let g1 = g8 / 255
  let b = b8 / 255
  if (g.curves) {
    const c = g.curves
    ;[r, g1, b] = [tableAt(c, 0, r), tableAt(c, 1, g1), tableAt(c, 2, b)]
  }
  if (g.hsl) [r, g1, b] = applyHsl(r, g1, b, g.hsl)
  if (g.lut && g.lutMix > 0) {
    const [lr, lg, lb] = sampleLut(g.lut, r, g1, b)
    r += (lr - r) * g.lutMix
    g1 += (lg - g1) * g.lutMix
    b += (lb - b) * g.lutMix
  }
  const m = clamp(mix, 0, 1)
  return [(r8 / 255 + (r - r8 / 255) * m) * 255, (g8 / 255 + (g1 - g8 / 255) * m) * 255, (b8 / 255 + (b - b8 / 255) * m) * 255]
}

/** RGBA pixels graded in place, each stage rounded to bytes as the GPU's framebuffer does. */
export function gradePixels(px: Uint8ClampedArray | Uint8Array, stages: Array<{ grade: PreparedGrade; mix: number }>) {
  for (const s of stages)
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = gradePixel(s.grade, s.mix, px[i], px[i + 1], px[i + 2])
      px[i] = Math.round(clamp(r, 0, 255))
      px[i + 1] = Math.round(clamp(g, 0, 255))
      px[i + 2] = Math.round(clamp(b, 0, 255))
    }
}

// ---------- frames: a clip's grade, adjustment layers ----------

/** The grades a video or image layer draws with (none when its grade does nothing). */
export function itemGrades(p: Project, it: { grade?: Grade }): FrameLayer['grades'] {
  return it.grade && !gradeNeutral(it.grade, p.luts) ? [{ grade: it.grade, mix: 1 }] : undefined
}

/** Effects an adjustment layer can carry: those that change the colour or the look, not the position. */
export const ADJUSTMENT_EFFECTS = ['blur', 'blackWhite', 'vignette', 'grain', 'vhs', 'flash'] as const

/** An adjustment layer at time t: a full-canvas layer whose backdrop filter recolours everything beneath it. */
export function adjustmentLayer(p: Project, track: Track, it: AdjustmentItem, local: number, z: number, t: number): FrameLayer | null {
  const W = p.width
  const H = p.height
  const u = Math.min(W, H) / 1080
  const opacity = clamp(sampleKeyframes(it.keyframes?.opacity, local, it.opacity ?? 1), 0, 1)
  if (opacity <= 0.001) return null
  const f = adjustToFilter(it.adjust, it.filter?.id, it.filter?.intensity ?? 100)
  const parts = f.filter ? [f.filter] : []
  const overlays: string[] = []
  if (f.vignette > 0) overlays.push(`radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${(f.vignette / 100).toFixed(2)}) 100%)`)
  const frame = Math.floor(t * p.fps)
  let blur = 0
  let bright = 1
  for (const fx of it.effects ?? []) {
    const k = fx.intensity / 100
    if (fx.type === 'blur') blur += 20 * k * u
    else if (fx.type === 'blackWhite') parts.push(`grayscale(${k.toFixed(2)})`)
    else if (fx.type === 'flash') bright *= 1 + 1.5 * k * Math.max(0, 1 - ((local * 2) % 1) * 4)
    else if (fx.type === 'vhs') {
      parts.push(`saturate(${(1 + 0.3 * k).toFixed(2)}) contrast(${(1 + 0.1 * k).toFixed(2)})`)
      overlays.push(`repeating-linear-gradient(0deg, rgba(0,0,0,${(0.18 * k).toFixed(2)}) 0 ${(2 * u).toFixed(2)}px, transparent ${(2 * u).toFixed(2)}px ${(4 * u).toFixed(2)}px)`)
    } else if (fx.type === 'vignette') overlays.push(`radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,${(0.75 * k).toFixed(2)}) 100%)`)
    else if (fx.type === 'grain') {
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' seed='${frame % 97}'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='${(0.35 * k).toFixed(2)}'/></svg>`
      overlays.push(`url("data:image/svg+xml;utf8,${svg.replace(/"/g, "'").replace(/#/g, '%23')}")`)
    }
  }
  if (bright !== 1) parts.push(`brightness(${bright.toFixed(3)})`)
  if (blur > 0.01) parts.push(`blur(${blur.toFixed(2)}px)`)
  return {
    itemId: it.id,
    trackId: track.id,
    type: 'adjustment',
    box: { cx: W / 2, cy: H / 2, width: W, height: H },
    transform: 'rotate(0deg) scale(1, 1)',
    opacity,
    filter: '',
    blend: 'normal',
    backdrop: parts.join(' ') || undefined,
    overlay: overlays.length ? overlays.join(', ') : undefined,
    grades: it.grade && !gradeNeutral(it.grade, p.luts) ? [{ grade: it.grade, mix: opacity }] : undefined,
    z,
  }
}

/** An adjustment layer's curves, HSL and LUT go onto every clip and image beneath it (after their own). */
export function spreadAdjustments(layers: FrameLayer[]) {
  for (const a of layers) {
    if (a.type !== 'adjustment' || !a.grades) continue
    for (const l of layers) if ((l.type === 'video' || l.type === 'image') && l.z < a.z) l.grades = [...(l.grades ?? []), ...a.grades]
  }
}

export function createAdjustmentItem(start: number, duration = 5, over: Partial<AdjustmentItem> = {}): AdjustmentItem {
  return { id: uid('adj'), type: 'adjustment', start, duration, name: 'Adjustment layer', opacity: 1, keyframes: {}, adjust: { ...NEUTRAL_ADJUST }, effects: [], ...over }
}

/**
 * Add an adjustment layer at `start` on a new overlay track above every picture track, so it covers all of them.
 * `duration` defaults to the rest of the project (at least 5 s). Returns the project and the new item's id.
 */
export function addAdjustmentLayer(p0: Project, start: number, duration?: number): { project: Project; id: string } {
  const p = clone(p0)
  const from = Math.max(0, start)
  const it = createAdjustmentItem(from, round(duration ?? Math.max(5, projectDuration(p) - from), 4))
  const track = insertTrack(p, 'overlay')
  track.name = 'Adjustment'
  track.items.push(it)
  p.updatedAt = Date.now()
  return { project: p, id: it.id }
}

/** Add a LUT to the project (reusing one with the same name and samples). */
export function addLut(p0: Project, name: string, lut: LutData): { project: Project; id: string } {
  const data = encodeLut(lut)
  const same = Object.values(p0.luts ?? {}).find((l) => l.name === name && l.size === lut.size && l.data === data)
  if (same) return { project: p0, id: same.id }
  const id = uid('lut')
  return { project: { ...p0, luts: { ...(p0.luts ?? {}), [id]: { id, name: name.slice(0, 120), size: lut.size, data } }, updatedAt: Date.now() }, id }
}

/** The project without the LUTs no clip or adjustment layer uses any more. */
export function pruneLuts(p: Project): Project {
  if (!p.luts) return p
  const used = new Set<string>()
  for (const t of p.tracks) for (const it of t.items) if ('grade' in it && it.grade?.lut) used.add(it.grade.lut.id)
  const keep = Object.fromEntries(Object.entries(p.luts).filter(([id]) => used.has(id)))
  return Object.keys(keep).length === Object.keys(p.luts).length ? p : { ...p, luts: keep }
}
