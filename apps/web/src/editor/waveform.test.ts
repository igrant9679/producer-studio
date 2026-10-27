// A long clip's record carries a shortened waveform; zoomed in past it, the timeline fetches the full one. Clips with
// a full inline waveform (older, or short) draw as before. (PIP-14)
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FULL_RATE, fetchFullWaveform, needsFull, peakBetween, useWaveformPeaks } from './waveform'

afterEach(() => vi.unstubAllGlobals())

describe('timeline waveform (PIP-14)', () => {
  it('reads peaks at the clip’s own rate', () => {
    // 4 peaks per second: second 2 is the loud one
    const p = { values: [0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.9, 0.1, 0], rate: 4, scale: 1 }
    expect(peakBetween(p, 2, 2.4)).toBe(0.9)
    expect(peakBetween(p, 0, 1.5)).toBe(0)
    expect(peakBetween({ values: Uint8Array.from([0, 255]), rate: FULL_RATE, scale: 1 / 255 }, 0, 0.02)).toBe(1)
  })

  it('asks for the full waveform only when zoomed in past the clip’s own peaks', () => {
    const long = { waveformRate: 0.5, waveformSrc: '/api/media/as1/waveform' }
    expect(needsFull(long, 10)).toBe(false) // 10 s per bar: 2 seconds per peak is enough
    expect(needsFull(long, 0.5)).toBe(true)
    expect(needsFull({ waveformRate: undefined, waveformSrc: undefined }, 0.01)).toBe(false)
  })

  it('fetches the full waveform once, and draws from it when zoomed in', async () => {
    const bytes = new Uint8Array(FULL_RATE * 10).fill(51)
    const fetch = vi.fn(async () => new Response(bytes, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const asset = { waveform: [0.2, 0.2, 0.2, 0.2, 0.2], waveformRate: 0.5, waveformSrc: '/api/media/as-fetch/waveform' }
    const zoomedOut = renderHook(() => useWaveformPeaks(asset, 4))
    expect(zoomedOut.result.current).toMatchObject({ rate: 0.5, scale: 1 })
    const zoomedIn = renderHook(() => useWaveformPeaks(asset, 0.06))
    await waitFor(() => expect(zoomedIn.result.current?.rate).toBe(FULL_RATE))
    expect(peakBetween(zoomedIn.result.current!, 1, 1.06)).toBeCloseTo(0.2)
    await fetchFullWaveform('/api/media/as-fetch/waveform')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('a failed fetch keeps the clip’s own peaks and is tried again later', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchFullWaveform('/api/media/as-202/waveform')).toBeNull()
    expect(await fetchFullWaveform('/api/media/as-202/waveform')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
