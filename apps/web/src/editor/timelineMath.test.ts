import { createProject, createTrack } from '@producer/core'
import { describe, expect, it } from 'vitest'
import {
  ROWS_TOP,
  dropTargetAt,
  fitZoom,
  gapToAboveIndex,
  layoutRows,
  marqueeHits,
  pxToTime,
  rulerLabel,
  sliderToZoom,
  snapAt,
  snapSpan,
  tickStep,
  timeToPx,
  timecode,
  zoomToSlider,
} from './timelineMath'

describe('px <-> time', () => {
  it('round-trips', () => {
    expect(timeToPx(2.5, 80)).toBe(200)
    expect(pxToTime(200, 80)).toBe(2.5)
    expect(pxToTime(timeToPx(7.123, 33), 33)).toBeCloseTo(7.123)
  })
  it('zoom slider is log scale and invertible', () => {
    expect(zoomToSlider(4)).toBeCloseTo(0)
    expect(zoomToSlider(600)).toBeCloseTo(1)
    expect(sliderToZoom(zoomToSlider(80))).toBeCloseTo(80)
  })
  it('fitZoom fits duration into width', () => {
    const z = fitZoom(20, 1000)
    expect(20 * z).toBeLessThan(1000)
    expect(20 * z).toBeGreaterThan(900)
  })
})

describe('ruler ticks', () => {
  it('majors are at least minPx apart', () => {
    for (const z of [5, 20, 80, 200, 600]) {
      const { major, minor } = tickStep(z, 72)
      expect(major * z).toBeGreaterThanOrEqual(72 - 1e-6)
      expect(minor).toBeLessThanOrEqual(major)
    }
  })
  it('labels', () => {
    expect(rulerLabel(65, 5)).toBe('1:05')
    expect(rulerLabel(1.5, 0.5, 30)).toBe('15f')
    expect(rulerLabel(2, 0.5, 30)).toBe('0:02')
  })
  it('timecode is frame accurate', () => {
    expect(timecode(0, 30)).toBe('00:00:00')
    expect(timecode(1.5, 30)).toBe('00:01:15')
    expect(timecode(61 + 29 / 30, 30)).toBe('01:01:29')
    expect(timecode(3600, 25)).toBe('01:00:00:00')
  })
})

describe('snapping', () => {
  const pts = [0, 2, 5, 9]
  it('snaps within the pixel threshold only', () => {
    // at 100 px/s, 8 px = 0.08 s
    expect(snapAt(2.05, pts, 100)).toMatchObject({ t: 2, snapped: true, at: 2 })
    expect(snapAt(2.2, pts, 100)).toMatchObject({ t: 2.2, snapped: false })
    // zoomed out: 8 px = 0.4 s
    expect(snapAt(2.3, pts, 20).t).toBe(2)
  })
  it('snaps a span by its nearer edge', () => {
    // span 1s long starting at 3.97 -> end 4.97 snaps to 5
    expect(snapSpan(3.97, 1, pts, 100)).toEqual({ start: 4, at: 5 })
    // start close to 2
    expect(snapSpan(2.03, 1, pts, 100)).toEqual({ start: 2, at: 2 })
    expect(snapSpan(3.5, 1, pts, 100)).toEqual({ start: 3.5 })
  })
})

describe('rows', () => {
  function proj() {
    const p = createProject()
    p.tracks.unshift(createTrack('audio'))
    p.tracks.push(createTrack('text'))
    p.tracks[2].items.push({ id: 't1', type: 'caption', start: 1, duration: 2, text: 'x' })
    return p
  }
  it('displays highest stacking index first', () => {
    const p = proj()
    const { rows } = layoutRows(p)
    expect(rows.map((r) => r.track.kind)).toEqual(['text', 'video', 'audio'])
    expect(rows[0].top).toBe(ROWS_TOP)
    expect(rows[1].top).toBeGreaterThan(rows[0].top + rows[0].height)
  })
  it('dropTargetAt resolves rows and gaps', () => {
    const { rows } = layoutRows(proj())
    const mid = rows[1].top + rows[1].height / 2
    expect(dropTargetAt(mid, rows)).toMatchObject({ type: 'row' })
    expect((dropTargetAt(mid, rows) as { row: { index: number } }).row.index).toBe(1)
    expect(dropTargetAt(0, rows)).toMatchObject({ type: 'gap', gap: 0 })
    expect(dropTargetAt(rows[1].top + 1, rows)).toMatchObject({ type: 'gap', gap: 1 })
    expect(dropTargetAt(9999, rows)).toMatchObject({ type: 'gap', gap: 3 })
  })
  it('gapToAboveIndex never goes below main', () => {
    const p = proj()
    const { rows } = layoutRows(p)
    const main = p.tracks.findIndex((t) => t.main)
    // gap above the text row (top): directly above stacking index 2
    expect(gapToAboveIndex(0, rows, main)).toBe(2)
    // gap between text and main: above main
    expect(gapToAboveIndex(1, rows, main)).toBe(1)
    // below main -> clamped to main
    expect(gapToAboveIndex(3, rows, main)).toBe(main)
  })
  it('marquee selects intersecting clips', () => {
    const p = proj()
    const { rows } = layoutRows(p)
    const r = rows[0]
    expect(marqueeHits({ x0: 50, y0: r.top + 2, x1: 120, y1: r.top + 10 }, rows, 100)).toEqual(['t1'])
    expect(marqueeHits({ x0: 400, y0: r.top, x1: 500, y1: r.top + 10 }, rows, 100)).toEqual([])
  })
})
