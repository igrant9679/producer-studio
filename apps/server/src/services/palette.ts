// Colours pulled from a logo image (A-21): raster logos are shrunk by ffmpeg to a few thousand pixels and quantised
// here (pure JS, no dependency); SVG logos give the colours written in them. Never fetches anything from the web.
import fs from 'node:fs'
import path from 'node:path'
import { hexToRgb, rgbToHex } from '@producer/core'
import { notFound } from '../http'
import { ffmpeg } from '../media/proc'
import { type AssetRow, SVG_MIME, localSource, tmpDir } from './assets'

/** Colours closer than this (RGB distance) count as one. */
const MERGE = 40

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * The main colours of RGBA pixels, most used first: opaque pixels are binned (4 bits a channel), the biggest bins
 * picked so no two are alike, and each one's colour is the average of the pixels it took in.
 */
export function paletteFromPixels(rgba: Uint8Array, max = 6): string[] {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    bin.n++
    bin.r += r
    bin.g += g
    bin.b += b
    bins.set(key, bin)
  }
  const sorted = [...bins.values()].map((x) => ({ n: x.n, c: [x.r / x.n, x.g / x.n, x.b / x.n] })).sort((a, b) => b.n - a.n)
  const total = sorted.reduce((t, x) => t + x.n, 0)
  const picked: Array<{ n: number; sum: number[]; c: number[] }> = []
  for (const s of sorted) {
    const near = picked.find((p) => dist(p.c, s.c) < MERGE)
    if (near) {
      for (let k = 0; k < 3; k++) near.sum[k] += s.c[k] * s.n
      near.n += s.n
      near.c = near.sum.map((v) => v / near.n)
    } else if (picked.length < max && s.n >= total * 0.005) picked.push({ n: s.n, sum: s.c.map((v) => v * s.n), c: [...s.c] })
  }
  return picked.sort((a, b) => b.n - a.n).map((p) => rgbToHex(p.c[0], p.c[1], p.c[2]))
}

/** The colours an SVG names (fill, stroke, stop-color, style: hex and rgb()), most used first. */
export function paletteFromSvg(svg: string, max = 6): string[] {
  const count = new Map<string, number>()
  const add = (hex: string | null) => {
    if (hex) count.set(hex, (count.get(hex) ?? 0) + 1)
  }
  for (const m of svg.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) add(rgbToHexOf(`#${m[1]}`))
  for (const m of svg.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) add(rgbToHex(Number(m[1]), Number(m[2]), Number(m[3])))
  const out: string[] = []
  for (const [hex] of [...count.entries()].sort((a, b) => b[1] - a[1])) {
    const rgb = hexToRgb(hex)!
    if (out.some((o) => dist(hexToRgb(o)!, rgb) < MERGE)) continue
    out.push(hex)
    if (out.length >= max) break
  }
  return out
}

function rgbToHexOf(hex: string): string | null {
  const rgb = hexToRgb(hex)
  return rgb ? rgbToHex(...rgb) : null
}

/** Side of the square a raster logo is shrunk to before quantising. */
const SAMPLE = 64

/** The colours of an image asset (a logo): its main colours, most used first. */
export async function logoPalette(row: AssetRow, max = 6): Promise<string[]> {
  if (row.kind !== 'image') throw notFound('That isn’t an image')
  const work = tmpDir('palette')
  try {
    const src = await localSource(row, work)
    if (row.mime === SVG_MIME) return paletteFromSvg(fs.readFileSync(src, 'utf8').slice(0, 2_000_000), max)
    const out = path.join(work, 'pixels.rgba')
    await ffmpeg(['-i', src, '-frames:v', '1', '-vf', `scale=${SAMPLE}:${SAMPLE}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', out], { timeoutMs: 30_000 })
    return paletteFromPixels(new Uint8Array(fs.readFileSync(out)), max)
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}
