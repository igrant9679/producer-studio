// Keyframe editing (E-16): curves, moves, eases, stepping, copy and paste.
import { describe, expect, it } from 'vitest'
import {
  EASE_CURVES,
  addAsset,
  addItem,
  adjacentKeyframe,
  compileToHyperFrames,
  copyKeyframes,
  createAudioItem,
  createProject,
  createShapeItem,
  cubicBezier,
  evaluate,
  findItem,
  keyframeTimes,
  moveKeyframes,
  pasteKeyframes,
  removeKeyframesAt,
  sampleKeyframes,
  setKeyframe,
  setKeyframeEase,
  updateItem,
  type Keyframe,
  type Project,
  type ShapeItem,
} from './index'

function project(): Project {
  let p = addItem(createProject({ id: 'p' }), createShapeItem(0, { id: 's1', duration: 4 }))
  p = setKeyframe(p, 's1', 'x', 0, 0)
  p = setKeyframe(p, 's1', 'x', 2, 200)
  p = setKeyframe(p, 's1', 'opacity', 2, 0.5)
  return setKeyframe(p, 's1', 'opacity', 3, 1)
}
const shape = (p: Project, id = 's1') => findItem(p, id)!.item as ShapeItem

describe('cubic-bezier easing', () => {
  it('matches the CSS curve at its ends and known points', () => {
    expect(cubicBezier([0, 0, 1, 1], 0.3)).toBeCloseTo(0.3, 5)
    expect(cubicBezier(EASE_CURVES.easeInOut, 0)).toBe(0)
    expect(cubicBezier(EASE_CURVES.easeInOut, 1)).toBeCloseTo(1, 6)
    expect(cubicBezier(EASE_CURVES.easeInOut, 0.5)).toBeCloseTo(0.5, 4)
    // CSS `ease` (0.25, 0.1, 0.25, 1) is about 0.8024 at x = 0.5
    expect(cubicBezier([0.25, 0.1, 0.25, 1], 0.5)).toBeCloseTo(0.8024, 3)
  })

  it('can overshoot, and the same input always gives the same value', () => {
    const back: [number, number, number, number] = [0.34, 1.56, 0.64, 1]
    expect(Math.max(...[0.5, 0.6, 0.7, 0.8].map((x) => cubicBezier(back, x)))).toBeGreaterThan(1)
    expect(cubicBezier(back, 0.37)).toBe(cubicBezier(back, 0.37))
  })

  it("a keyframe's curve shapes the move to the next keyframe", () => {
    const kfs: Keyframe[] = [{ t: 0, value: 0, ease: 'bezier', bezier: [0.9, 0, 1, 0.1] }, { t: 1, value: 100 }]
    expect(sampleKeyframes(kfs, 0.5, 0)).toBeLessThan(10)
    expect(sampleKeyframes([{ ...kfs[0], ease: 'linear' }, kfs[1]], 0.5, 0)).toBe(50)
  })

  it('the frame evaluated for the preview and the document the export runs carry the same curve', () => {
    let p = setKeyframeEase(project(), 's1', 'x', 0, 'bezier', [0.8, 0, 0.2, 1])
    const layer = evaluate(p, 0.5).layers.find((l) => l.itemId === 's1')!
    expect(layer.box.cx - p.width / 2).toBeCloseTo(200 * cubicBezier([0.8, 0, 0.2, 1], 0.25), 3)
    // the export bundles the same runtime and evaluates this JSON
    const html = compileToHyperFrames(p, { assetPath: () => '', runtimePath: 'runtime.js', gsapPath: 'gsap.js', fontFaceCss: '' })
    expect(html).toContain('"ease":"bezier","bezier":[0.8,0,0.2,1]')
    p = updateItem<ShapeItem>(p, 's1', { locked: true })
    expect(setKeyframeEase(p, 's1', 'x', 0, 'linear')).toBe(p)
  })
})

describe('keyframe ops', () => {
  it('moving a time moves every property keyed there, and replaces one already at the target', () => {
    const p = moveKeyframes(project(), 's1', 2, 1)
    expect(shape(p).keyframes.x!.map((k) => k.t)).toEqual([0, 1])
    expect(shape(p).keyframes.opacity!.map((k) => [k.t, k.value])).toEqual([[1, 0.5], [3, 1]])
    const onto = moveKeyframes(project(), 's1', 2, 3, ['opacity'])
    expect(shape(onto).keyframes.opacity).toEqual([{ t: 3, value: 0.5, ease: 'easeInOut' }])
    // kept inside the item
    expect(shape(moveKeyframes(project(), 's1', 2, 99, ['x'])).keyframes.x!.map((k) => k.t)).toEqual([0, 4])
  })

  it('setting an ease, and a curve that stays in range', () => {
    let p = setKeyframeEase(project(), 's1', 'x', 0, 'hold')
    expect(shape(p).keyframes.x![0]).toMatchObject({ ease: 'hold' })
    expect(shape(p).keyframes.x![0].bezier).toBeUndefined()
    p = setKeyframeEase(p, 's1', 'x', 0, 'bezier', [1.5, 3, -2, -4])
    expect(shape(p).keyframes.x![0].bezier).toEqual([1, 2, 0, -1])
    expect(setKeyframeEase(p, 's1', 'x', 1.3, 'linear')).toBe(p)
  })

  it('steps to the previous and next keyframe', () => {
    const it = shape(project())
    expect(keyframeTimes(it)).toEqual([0, 2, 3])
    expect(adjacentKeyframe(it, 0, 1, 30)).toBe(2)
    expect(adjacentKeyframe(it, 2, 1, 30)).toBe(3)
    expect(adjacentKeyframe(it, 3, 1, 30)).toBeUndefined()
    expect(adjacentKeyframe(it, 2.5, -1, 30)).toBe(2)
    expect(adjacentKeyframe(it, 2, -1, 30, 'opacity')).toBeUndefined()
  })

  it('copies keyframes and pastes them at another time or onto another item', () => {
    const clip = copyKeyframes(shape(project()), ['opacity'])!
    expect(clip).toEqual({ keyframes: { opacity: [{ t: 0, value: 0.5, ease: 'easeInOut' }, { t: 1, value: 1, ease: 'easeInOut' }] }, span: 1 })
    let p = addItem(project(), createShapeItem(0, { id: 's2', duration: 1.5 }))
    p = pasteKeyframes(p, 's2', clip, 1)
    // the one past the end is left out
    expect(shape(p, 's2').keyframes.opacity!.map((k) => k.t)).toEqual([1])
    const one = copyKeyframes(shape(project()), undefined, [2])!
    expect(Object.keys(one.keyframes).sort()).toEqual(['opacity', 'x'])
    // an audio clip takes only volume
    p = addAsset(p, { id: 'au', kind: 'audio', name: 'a', src: 'a', duration: 5 })
    p = addItem(p, createAudioItem(p.assets.au, 0, { id: 'a1' }))
    expect(pasteKeyframes(p, 'a1', clip, 0)).toBe(p)
  })

  it('removes every keyframe at a time', () => {
    const p = removeKeyframesAt(project(), 's1', 2)
    expect(shape(p).keyframes).toEqual({ x: [{ t: 0, value: 0, ease: 'easeInOut' }], opacity: [{ t: 3, value: 1, ease: 'easeInOut' }] })
  })
})
