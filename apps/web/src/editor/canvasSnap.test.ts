// Canvas layout maths (E-18): bounds, snapping, align, distribute, safe zones, ruler spacing.
import { describe, expect, it } from 'vitest'
import { alignBoxes, distributeBoxes, objBox, rulerStep, safeRect, snapBox, snapTargets } from './canvasSnap'

describe('canvas snapping', () => {
  it('a rotated object is bounded by its turned corners', () => {
    const b = objBox('a', 100, 100, 200, 100, 90)
    expect(b.left).toBeCloseTo(50)
    expect(b.right).toBeCloseTo(150)
    expect(b.top).toBeCloseTo(0)
    expect(b.bottom).toBeCloseTo(200)
  })

  it('snaps an edge or the centre to the nearest target within the threshold, and names the lines', () => {
    const other = objBox('o', 1500, 540, 200, 200, 0)
    const targets = snapTargets(1920, 1080, [other], { v: [300], h: [] })
    // right edge 1396 is 4 px from the other's left edge (1400)
    expect(snapBox({ left: 1196, right: 1396, top: 100, bottom: 200 }, targets, 6)).toEqual({ dx: 4, dy: 0, lines: { x: [1400], y: [] } })
    // centre 958 -> the canvas centre; the top 2 px from the canvas top
    const r = snapBox({ left: 858, right: 1058, top: 2, bottom: 102 }, targets, 6)
    expect(r).toMatchObject({ dx: 2, dy: -2 })
    expect(r.lines).toEqual({ x: [960], y: [0] })
    // a guide
    expect(snapBox({ left: 303, right: 403, top: 500, bottom: 560 }, targets, 6).dx).toBe(-3)
    // too far: nothing
    expect(snapBox({ left: 320, right: 420, top: 500, bottom: 560 }, targets, 6)).toEqual({ dx: 0, dy: 0, lines: { x: [], y: [] } })
  })

  it('the safe area is a snap target too', () => {
    const safe = safeRect('tiktok', 1080, 1920)
    expect(safe).toEqual({ left: 54, top: 154, right: 929, bottom: 1536 })
    const t = snapTargets(1080, 1920, [], undefined, safe)
    expect(snapBox({ left: 100, right: 300, top: 1430, bottom: 1533 }, t, 6).dy).toBe(3)
  })
})

describe('align and distribute', () => {
  const a = objBox('a', 200, 200, 100, 100, 0)
  const b = objBox('b', 500, 260, 200, 60, 0)
  const c = objBox('c', 1200, 400, 100, 100, 0)

  it('aligns edges and centres to the reference', () => {
    const ref = { left: 150, top: 150, right: 600, bottom: 450 }
    expect(alignBoxes([a, b], 'left', ref)).toEqual(new Map([['a', { dx: 0, dy: 0 }], ['b', { dx: -250, dy: 0 }]]))
    expect(alignBoxes([a, b], 'bottom', ref).get('a')).toEqual({ dx: 0, dy: 200 })
    expect(alignBoxes([a], 'hcenter', { left: 0, top: 0, right: 1920, bottom: 1080 }).get('a')).toEqual({ dx: 760, dy: 0 })
  })

  it('distributes three or more with equal gaps; the outer ones stay put', () => {
    const d = distributeBoxes([c, a, b], 'x')
    expect(d.get('a')).toEqual({ dx: 0, dy: 0 })
    expect(d.get('c')).toEqual({ dx: 0, dy: 0 })
    // span 150..1250 holds 400 px of boxes: gaps of 350, so b's left goes from 400 to 600
    expect(d.get('b')).toEqual({ dx: 200, dy: 0 })
    expect(distributeBoxes([a, b], 'x').size).toBe(0)
  })
})

it('ruler labels stay readable at any zoom', () => {
  expect(rulerStep(1)).toBe(100)
  expect(rulerStep(0.25)).toBe(250)
  expect(rulerStep(4)).toBe(20)
})
