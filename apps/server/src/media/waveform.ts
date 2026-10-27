// Waveform peaks: ~50 per second from analyseAudio. A 3-hour recording has half a million, which used to ride along in
// the clip's row, every project using it, the job result and every live update (about 3.5 MB each). The clip now
// keeps at most WAVEFORM_INLINE_MAX of them (each window's loudest) and the full waveform is a file next to it
// (`waveform.bin`: one byte per peak, 0..255, at 50 per second) that the editor fetches when it zooms in.

export const WAVEFORM_RATE = 50
export const WAVEFORM_INLINE_MAX = 4000

/** At most `max` peaks: the loudest of every k consecutive ones, at 50/k per second (k a whole number). */
export function inlineWaveform(peaks: number[], rate = WAVEFORM_RATE, max = WAVEFORM_INLINE_MAX): { peaks: number[]; rate: number } {
  if (peaks.length <= max) return { peaks, rate }
  const k = Math.ceil(peaks.length / max)
  const out: number[] = []
  for (let i = 0; i < peaks.length; i += k) {
    let m = 0
    for (let j = i; j < Math.min(i + k, peaks.length); j++) m = Math.max(m, peaks[j] ?? 0)
    out.push(m)
  }
  return { peaks: out, rate: rate / k }
}

/** The full waveform as stored: one byte per peak. */
export function waveformBytes(peaks: ArrayLike<number>): Buffer {
  return Buffer.from(Uint8Array.from(peaks as ArrayLike<number>, (p) => Math.round(Math.min(1, Math.max(0, p)) * 255)))
}
