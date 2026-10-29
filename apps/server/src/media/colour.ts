// Which colour matrix a video's pixels were made in, so the preview and the export read the same colours.
//
// The editor plays the proxy in the browser, which decodes it with the matrix the file is tagged with (an untagged HD
// file as BT.709). The export draws video from JPEG frames ffmpeg extracts, and a JPEG is always read as BT.601: the
// YUV values go through unchanged, whatever the file is tagged with. So the same file showed two greens (the seed's
// Sample A: 216 in the editor, 254 in the export) and a key or grade tuned in the preview missed in the export.
// Now each proxy is tagged with the matrix its source was made in (the browser reads it right), and the export
// converts a non-BT.601 source to BT.601 values before HyperFrames extracts its frames (they read right too).
import type { ProbeResult } from './process'

/** The BT.601 family: what a JPEG is read as. Values ffprobe reports for color_space. */
const BT601 = new Set(['smpte170m', 'bt470bg'])
const KNOWN = new Set(['bt709', 'smpte170m', 'bt470bg', 'bt2020nc', 'bt2020c', 'smpte240m', 'fcc'])

export interface VideoMatrix {
  /** ffmpeg's name for the matrix (color_space). */
  matrix: string
  /** The file says so; otherwise it was worked out (see `videoMatrix`). */
  tagged: boolean
}

/**
 * The matrix a video's pixels are in: the file's tag; else, for a file ffmpeg wrote without one, BT.601 (ffmpeg
 * converts RGB with BT.601 unless told otherwise, and doesn't tag it: the seed's samples, screen grabs made with
 * ffmpeg); else the usual rule for untagged video, BT.709 from 720 lines (HD) up and BT.601 below.
 */
export function videoMatrix(info: Pick<ProbeResult, 'colorSpace' | 'encoder' | 'width' | 'height'>): VideoMatrix {
  if (info.colorSpace && KNOWN.has(info.colorSpace)) return { matrix: info.colorSpace, tagged: true }
  if (/^Lavf|^Lavc|ffmpeg/i.test(info.encoder ?? '')) return { matrix: 'smpte170m', tagged: false }
  const hd = Math.min(info.width ?? 0, info.height ?? 0) >= 720 || Math.max(info.width ?? 0, info.height ?? 0) >= 1280
  return { matrix: hd ? 'bt709' : 'smpte170m', tagged: false }
}

export const isBt601 = (matrix: string) => BT601.has(matrix)

/** Output options that tag an SDR encode with `matrix` (its usual primaries and transfer go with it). */
export function colourTagArgs(matrix: string): string[] {
  const prim = matrix === 'bt709' ? 'bt709' : matrix === 'bt470bg' ? 'bt470bg' : matrix.startsWith('bt2020') ? 'bt2020' : 'smpte170m'
  const trc = matrix === 'bt709' ? 'bt709' : matrix.startsWith('bt2020') ? 'bt2020-10' : 'smpte170m'
  return ['-colorspace', matrix, '-color_primaries', prim, '-color_trc', trc]
}

/** swscale's name for a matrix (scale's in_color_matrix). */
function swsMatrix(m: string): string {
  if (m === 'bt709') return 'bt709'
  if (m.startsWith('bt2020')) return 'bt2020'
  if (m === 'smpte240m') return 'smpte240m'
  if (m === 'fcc') return 'fcc'
  return 'bt601'
}

/**
 * Filters that turn `matrix` YUV into the BT.601 YUV that gives the same colours (through RGB: swscale applies a
 * matrix only between YUV and RGB). For a source the export reads through JPEG frames.
 */
export function toBt601Filters(matrix: string, range?: string): string[] {
  return [`scale=in_color_matrix=${swsMatrix(matrix)}:in_range=${range === 'pc' ? 'pc' : 'tv'}`, 'format=gbrp', 'scale=out_color_matrix=bt601:out_range=tv', 'format=yuv420p']
}
