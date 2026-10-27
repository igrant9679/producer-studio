// Waveform peaks for the timeline. A clip's record carries at most ~4,000 peaks (`waveformRate` per second); zoomed in
// past them, the full waveform (one byte per peak, 50 per second) is fetched once from `waveformSrc`. (PIP-14)
import { useEffect, useMemo, useState } from 'react'
import type { Asset } from '@producer/core'

export const FULL_RATE = 50

export interface Peaks {
  values: ArrayLike<number>
  /** Peaks per second. */
  rate: number
  /** Multiplier to 0..1 (1/255 for the stored bytes). */
  scale: number
}

const cache = new Map<string, Promise<Uint8Array | null>>()

/** The full waveform at `src`, fetched once (a failed fetch is tried again next time). */
export function fetchFullWaveform(src: string): Promise<Uint8Array | null> {
  let p = cache.get(src)
  if (!p) {
    p = fetch(src, { credentials: 'include' })
      .then(async (r) => (r.status === 200 ? new Uint8Array(await r.arrayBuffer()) : null))
      .catch(() => null)
      .then((v) => {
        if (!v) cache.delete(src)
        return v
      })
    cache.set(src, p)
  }
  return p
}

/** Whether bars `secondsPerBar` apart need more detail than the clip's own peaks have. */
export function needsFull(asset: Pick<Asset, 'waveformRate' | 'waveformSrc'>, secondsPerBar: number): boolean {
  return !!asset.waveformSrc && secondsPerBar * (asset.waveformRate ?? FULL_RATE) < 1
}

/** The loudest peak (0..1) from t0 to t1 seconds. */
export function peakBetween(p: Peaks, t0: number, t1: number): number {
  let m = 0
  for (let k = Math.max(0, Math.floor(t0 * p.rate)); k <= Math.floor(t1 * p.rate) && k < p.values.length; k++) m = Math.max(m, p.values[k] ?? 0)
  return m * p.scale
}

/** The peaks to draw a clip with at this zoom: its own, or the full waveform once fetched. */
export function useWaveformPeaks(asset: Pick<Asset, 'waveform' | 'waveformRate' | 'waveformSrc'>, secondsPerBar: number): Peaks | null {
  const want = needsFull(asset, secondsPerBar) ? asset.waveformSrc! : null
  const [full, setFull] = useState<{ src: string; data: Uint8Array } | null>(null)
  useEffect(() => {
    if (!want || full?.src === want) return
    let live = true
    void fetchFullWaveform(want).then((data) => {
      if (live && data) setFull({ src: want, data })
    })
    return () => {
      live = false
    }
  }, [want, full?.src])
  const fullData = want && full?.src === want ? full.data : null
  const { waveform, waveformRate } = asset
  return useMemo(() => {
    if (fullData) return { values: fullData, rate: FULL_RATE, scale: 1 / 255 }
    return waveform?.length ? { values: waveform, rate: waveformRate ?? FULL_RATE, scale: 1 } : null
  }, [fullData, waveform, waveformRate])
}
