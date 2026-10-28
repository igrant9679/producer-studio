// Video scopes from a frame's RGBA pixels: histogram, luma waveform and vectorscope (Rec. 709).

/** Rec. 709 luma of 0..255 channels, 0..255. */
export function luma709(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export interface Histogram {
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
  y: Uint32Array
}

/** How many pixels have each level (0..255) in red, green, blue and luma. */
export function histogram(px: ArrayLike<number>): Histogram {
  const h: Histogram = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), y: new Uint32Array(256) }
  for (let i = 0; i + 3 < px.length; i += 4) {
    h.r[px[i]]++
    h.g[px[i + 1]]++
    h.b[px[i + 2]]++
    h.y[Math.min(255, Math.round(luma709(px[i], px[i + 1], px[i + 2])))]++
  }
  return h
}

/**
 * Luma waveform: for each of `cols` columns across the frame, how many pixels sit at each of `levels` luma levels
 * (row 0 = black). Indexed [level * cols + col].
 */
export function waveform(px: ArrayLike<number>, width: number, height: number, cols = width, levels = 128): Uint32Array {
  const out = new Uint32Array(cols * levels)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const c = Math.min(cols - 1, Math.floor((x * cols) / width))
      const l = Math.min(levels - 1, Math.floor((luma709(px[i], px[i + 1], px[i + 2]) / 256) * levels))
      out[l * cols + c]++
    }
  return out
}

/**
 * Vectorscope: pixels placed by their colour difference (Cb right, Cr up) on a size × size grid, counted. The centre
 * is grey; the edge of the circle is fully saturated. Indexed [row * size + col], row 0 at the top.
 */
export function vectorscope(px: ArrayLike<number>, size = 128): Uint32Array {
  const out = new Uint32Array(size * size)
  const half = (size - 1) / 2
  for (let i = 0; i + 3 < px.length; i += 4) {
    const { cb, cr } = chroma709(px[i], px[i + 1], px[i + 2])
    const col = Math.round(half + cb * 2 * half)
    const row = Math.round(half - cr * 2 * half)
    if (col >= 0 && col < size && row >= 0 && row < size) out[row * size + col]++
  }
  return out
}

/** Rec. 709 colour differences of 0..255 channels, each -0.5..0.5. */
export function chroma709(r: number, g: number, b: number): { cb: number; cr: number } {
  const y = luma709(r, g, b) / 255
  return { cb: (b / 255 - y) / 1.8556, cr: (r / 255 - y) / 1.5748 }
}

/** Where 100 % red, yellow, green, cyan, blue and magenta land on a vectorscope (for its targets). */
export const VECTOR_TARGETS = (
  [
    ['R', 255, 0, 0],
    ['Yl', 255, 255, 0],
    ['G', 0, 255, 0],
    ['Cy', 0, 255, 255],
    ['B', 0, 0, 255],
    ['Mg', 255, 0, 255],
  ] as const
).map(([name, r, g, b]) => ({ name, ...chroma709(r, g, b) }))
