import { describe, expect, it } from 'vitest'
import {
  addAdjustmentLayer,
  addAsset,
  addItem,
  addLut,
  applyHsl,
  createImageItem,
  createProject,
  createVideoItem,
  curvesTable,
  decodeLut,
  evalCurve,
  evaluate,
  gradeNeutral,
  gradePixel,
  gradePixels,
  hueWeights,
  mainTrack,
  parseCube,
  prepareGrade,
  pruneLuts,
  rgbToHsl,
  sampleLut,
  updateItem,
  type AdjustmentItem,
  type Asset,
  type Grade,
  type Project,
  type VideoItem,
} from './index'

const asset = (id: string): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration: 10, width: 1920, height: 1080 })

function cube(size: number, f: (r: number, g: number, b: number) => [number, number, number], head = ''): string {
  const lines = [`TITLE "test"`, `LUT_3D_SIZE ${size}`, head]
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(f(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => v.toFixed(6)).join(' '))
  return lines.join('\n')
}

describe('curves', () => {
  it('a straight curve leaves every level alone, and the table maps i to i', () => {
    expect(evalCurve(undefined, 0.3)).toBeCloseTo(0.3)
    expect(evalCurve([[0, 0], [1, 1]], 0.71)).toBeCloseTo(0.71)
    const t = curvesTable({})
    for (let i = 0; i < 256; i += 17) expect([t[i * 4], t[i * 4 + 1], t[i * 4 + 2]]).toEqual([i, i, i])
  })

  it('goes through its points without overshooting between them (monotone)', () => {
    const pts: Array<[number, number]> = [[0, 0], [0.25, 0.1], [0.5, 0.5], [0.75, 0.95], [1, 1]]
    for (const [x, y] of pts) expect(evalCurve(pts, x)).toBeCloseTo(y, 5)
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const v = evalCurve(pts, i / 100)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      prev = v
    }
    // flat beyond its end points (a lifted black, a lowered white)
    expect(evalCurve([[0.2, 0.1], [0.8, 0.9]], 0)).toBeCloseTo(0.1)
    expect(evalCurve([[0.2, 0.1], [0.8, 0.9]], 1)).toBeCloseTo(0.9)
  })

  it('each channel curve takes the master curve’s output', () => {
    // master inverts, red then halves
    const t = curvesTable({ master: [[0, 1], [1, 0]], r: [[0, 0], [1, 0.5]] })
    expect(t[0]).toBe(128) // r: master(0) = 1 -> 0.5
    expect(t[1]).toBe(255) // g: master(0) = 1
    expect(t[255 * 4 + 1]).toBe(0)
  })
})

describe('HSL by hue range', () => {
  it('splits a hue between the two nearest ranges', () => {
    expect(hueWeights(0)).toEqual([[0, 1], [1, 0]])
    expect(hueWeights(15)).toEqual([[0, 0.5], [1, 0.5]])
    expect(hueWeights(90)).toEqual([[2, 0.5], [3, 0.5]])
    // magenta to red wraps round
    expect(hueWeights(330)).toEqual([[7, 0.5], [0, 0.5]])
  })

  it('moves only the colours in the chosen range, and never greys', () => {
    const v = new Float32Array(24)
    v[5 * 3 + 1] = -100 // blue: no saturation
    const [r, g, b] = applyHsl(0.1, 0.1, 0.9, v)
    expect(Math.abs(r - g)).toBeLessThan(0.01)
    expect(Math.abs(g - b)).toBeLessThan(0.01)
    // a red pixel is untouched
    expect(applyHsl(0.9, 0.1, 0.1, v).map((x) => +x.toFixed(4))).toEqual([0.9, 0.1, 0.1])
    // grey stays grey even with every range changed
    const all = new Float32Array(24).fill(80)
    expect(applyHsl(0.5, 0.5, 0.5, all)).toEqual([0.5, 0.5, 0.5])
  })

  it('shifts a hue by up to 30° and lightens or darkens it', () => {
    const v = new Float32Array(24)
    v[0] = 100 // red hue +30°
    const out = applyHsl(1, 0, 0, v)
    expect(rgbToHsl(...out)[0]).toBeCloseTo(30, 0)
    const dark = new Float32Array(24)
    dark[2] = -100
    expect(rgbToHsl(...applyHsl(1, 0, 0, dark))[2]).toBeCloseTo(0.5 * 0.4, 2)
  })
})

describe('.cube LUTs', { timeout: 20_000 }, () => {
  it('reads a 3D LUT and samples it between its points', () => {
    const { title, lut } = parseCube(cube(17, (r, g, b) => [1 - r, g * g, b]))
    expect(title).toBe('test')
    expect(lut.size).toBe(17)
    const [r, g, b] = sampleLut(lut, 0.25, 0.5, 0.75)
    expect(r).toBeCloseTo(0.75, 2)
    expect(g).toBeCloseTo(0.25, 1)
    expect(b).toBeCloseTo(0.75, 2)
  })

  it('resamples a large LUT to 33 points and honours its domain', { timeout: 30_000 }, () => {
    const big = parseCube(cube(41, (r, g, b) => [r, g, b]))
    expect(big.lut.size).toBe(33)
    expect(sampleLut(big.lut, 0.5, 0.2, 0.9).map((x) => +x.toFixed(2))).toEqual([0.5, 0.2, 0.9])
    // domain 0..2: an input of 1 reads the middle of the table
    const dom = parseCube(cube(5, (r) => [r, r, r], 'DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2'))
    expect(sampleLut(dom.lut, 1, 1, 1)[0]).toBeCloseTo(0.5, 1)
  })

  it('makes a 1D LUT into a 3D one', () => {
    const text = ['LUT_1D_SIZE 3', '0 0 0', '0.25 0.5 0.75', '1 1 1'].join('\n')
    const { lut } = parseCube(text)
    expect(sampleLut(lut, 0.5, 0.5, 0.5).map((x) => +x.toFixed(2))).toEqual([0.25, 0.5, 0.75])
  })

  it('says what is wrong with a broken file', () => {
    expect(() => parseCube('hello')).toThrow(/no LUT_3D_SIZE/)
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow(/should have 8 entries but has 1/)
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 x')).toThrow(/not three numbers/)
  })

  it('keeps the LUT in the project, round-trips its samples, and drops it when unused', () => {
    const { lut } = parseCube(cube(9, (r, g, b) => [b, g, r]))
    let p = createProject()
    p = addAsset(p, asset('a'))
    p = addItem(p, createVideoItem(p.assets.a, 0))
    const r1 = addLut(p, 'Swap.cube', lut)
    expect(addLut(r1.project, 'Swap.cube', lut).id).toBe(r1.id)
    p = r1.project
    expect(decodeLut(p.luts![r1.id])!.data).toEqual(lut.data)
    const id = mainTrack(p)!.items[0].id
    p = updateItem<VideoItem>(p, id, { grade: { lut: { id: r1.id, intensity: 100 } } })
    expect(Object.keys(pruneLuts(p).luts!)).toEqual([r1.id])
    p = updateItem<VideoItem>(p, id, { grade: undefined })
    expect(pruneLuts(p).luts).toEqual({})
  })
})

describe('a whole grade', () => {
  function withLut(): { p: Project; grade: Grade } {
    const { lut } = parseCube(cube(9, (r, g, b) => [1 - r, 1 - g, 1 - b]))
    const { project, id } = addLut(createProject(), 'Invert', lut)
    return { p: project, grade: { lut: { id, intensity: 50 } } }
  }

  it('is neutral until it changes something', () => {
    expect(gradeNeutral(undefined)).toBe(true)
    expect(gradeNeutral({ curves: { master: [[0, 0], [1, 1]] }, hsl: { red: { h: 0, s: 0, l: 0 } } })).toBe(true)
    // a LUT that isn't in the project does nothing
    expect(gradeNeutral({ lut: { id: 'gone', intensity: 100 } }, {})).toBe(true)
    expect(gradeNeutral({ curves: { r: [[0, 0.1], [1, 1]] } })).toBe(false)
  })

  it('runs curves, then HSL, then the LUT at its intensity, then mixes the stage in', () => {
    const { p, grade } = withLut()
    const g = prepareGrade(grade, p.luts)
    // inverting LUT at 50 %: every level goes half way to its inverse
    const [r, gg, b] = gradePixel(g, 1, 200, 100, 0)
    expect(r).toBeCloseTo(127.5, 0)
    expect(gg).toBeCloseTo(127.5, 0)
    expect(b).toBeCloseTo(127.5, 0)
    // the same stage mixed in at 0 changes nothing
    expect(gradePixel(g, 0, 200, 100, 0)).toEqual([200, 100, 0])
    const px = new Uint8ClampedArray([255, 0, 0, 255])
    gradePixels(px, [{ grade: prepareGrade({ curves: { master: [[0, 1], [1, 0]] } }), mix: 1 }])
    expect([...px]).toEqual([0, 255, 255, 255])
  })
})

describe('frames', () => {
  function graded(): { p: Project; id: string } {
    let p = createProject({ width: 1280, height: 720 })
    p = addAsset(p, asset('a'))
    p = addItem(p, createVideoItem(p.assets.a, 0, { duration: 4 }))
    const id = mainTrack(p)!.items[0].id
    return { p, id }
  }

  it("carries a clip's grade on its layer, and nothing when the grade is neutral", () => {
    let { p, id } = graded()
    expect(evaluate(p, 1).layers[0].grades).toBeUndefined()
    const grade: Grade = { curves: { master: [[0, 0.1], [1, 0.9]] } }
    p = updateItem<VideoItem>(p, id, { grade })
    expect(evaluate(p, 1).layers[0].grades).toEqual([{ grade, mix: 1 }])
  })

  it('an adjustment layer covers the whole canvas on top, filters what is beneath and grades the clips beneath', () => {
    let { p } = graded()
    p = addItem(p, createImageItem({ id: 'img', kind: 'image', name: 'i.png', src: 'i.png', width: 100, height: 100 }, 0, { duration: 4 }), undefined)
    const r = addAdjustmentLayer(p, 1, 2)
    p = r.project
    expect(p.tracks.at(-1)!.kind).toBe('overlay')
    const grade: Grade = { hsl: { blue: { h: 0, s: -100, l: 0 } } }
    p = updateItem<AdjustmentItem>(p, r.id, { adjust: { ...(p.tracks.at(-1)!.items[0] as AdjustmentItem).adjust, saturation: -50 }, grade, effects: [{ id: 'fx', type: 'vignette', intensity: 50 }], opacity: 0.8 })
    // not before it starts
    expect(evaluate(p, 0.5).layers.find((l) => l.type === 'adjustment')).toBeUndefined()
    const f = evaluate(p, 1.5)
    const adj = f.layers.find((l) => l.type === 'adjustment')!
    expect(adj.box).toEqual({ cx: 640, cy: 360, width: 1280, height: 720 })
    expect(adj.backdrop).toBe('saturate(0.500)')
    expect(adj.overlay).toMatch(/radial-gradient/)
    expect(adj.opacity).toBe(0.8)
    // every picture beneath it takes its curves/HSL/LUT, at its strength
    for (const l of f.layers.filter((x) => x.type === 'video' || x.type === 'image')) {
      expect(l.z).toBeLessThan(adj.z)
      expect(l.grades).toEqual([{ grade, mix: 0.8 }])
    }
  })

  it('an adjustment layer fades with its opacity keyframes and only takes colour effects', () => {
    let { p } = graded()
    const r = addAdjustmentLayer(p, 0, 4)
    p = updateItem<AdjustmentItem>(r.project, r.id, { keyframes: { opacity: [{ t: 0, value: 0 }, { t: 2, value: 1 }] }, effects: [{ id: 'a', type: 'blackWhite', intensity: 100 }, { id: 'b', type: 'shake', intensity: 100 }] })
    const at1 = evaluate(p, 1).layers.find((l) => l.type === 'adjustment')!
    expect(at1.opacity).toBeCloseTo(0.5)
    expect(at1.backdrop).toBe('grayscale(1.00)')
    // nothing to draw while it is fully transparent
    expect(evaluate(p, 0).layers.find((l) => l.type === 'adjustment')).toBeUndefined()
  })
})
