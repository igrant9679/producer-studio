// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addAdjustmentLayer,
  addAsset,
  addItem,
  addLut,
  compileToHyperFrames,
  createProject,
  createVideoItem,
  gradePixels,
  mainTrack,
  parseCube,
  prepareGrade,
  updateItem,
  type AdjustmentItem,
  type Grade,
  type Project,
  type VideoItem,
} from './index'
import { StageRenderer } from './runtime'

/**
 * jsdom draws nothing: a 2D context that copies a source's `__px` (its pixels) and hands them back, and no WebGL,
 * so the renderer takes its CPU path — the same maths the shader runs (colour.ts).
 */
type Px = { __px?: Uint8ClampedArray }
let restore: () => void
beforeAll(() => {
  const P = HTMLCanvasElement.prototype as unknown as { getContext: unknown }
  const orig = P.getContext
  P.getContext = function (this: HTMLCanvasElement & Px & { __ctx?: unknown }, kind: string) {
    if (kind !== '2d') return null
    this.__ctx ??= {
      canvas: this,
      clearRect: () => undefined,
      drawImage: (src: Px) => {
        if (src.__px) this.__px = new Uint8ClampedArray(src.__px)
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(this.__px ?? new Uint8ClampedArray(w * h * 4)), width: w, height: h }),
      putImageData: (img: { data: Uint8ClampedArray }) => (this.__px = new Uint8ClampedArray(img.data)),
    }
    return this.__ctx
  }
  restore = () => (P.getContext = orig)
})
afterAll(() => restore())

/** A frame of two pixels: an orange and a sky blue. */
const FRAME = [230, 120, 40, 255, 70, 140, 230, 255]

function ready<T extends HTMLElement>(el: T, px = FRAME): T {
  const d = (k: string, v: unknown) => Object.defineProperty(el, k, { configurable: true, get: () => v })
  if (el instanceof HTMLVideoElement) {
    d('readyState', 4)
    d('videoWidth', 2)
    d('videoHeight', 1)
  } else {
    d('complete', true)
    d('naturalWidth', 2)
    d('naturalHeight', 1)
  }
  ;(el as unknown as Px).__px = new Uint8ClampedArray(px)
  return el
}

function project(grade: Grade): { p: Project; id: string } {
  let p = createProject({ width: 320, height: 180 })
  p = addAsset(p, { id: 'a', kind: 'video', name: 'a.mp4', src: 'a.mp4', duration: 10, width: 320, height: 180 })
  p = addItem(p, createVideoItem(p.assets.a, 0, { duration: 4 }))
  const id = mainTrack(p)!.items[0].id
  const { lut } = parseCube(['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].map((l, i) => (i ? l.split(' ').map((v) => String(1 - +v)).join(' ') : l)).join('\n'))
  const r = addLut(p, 'Invert', lut)
  p = updateItem<VideoItem>(r.project, id, { grade: { ...grade, ...(grade.lut ? { lut: { id: r.id, intensity: grade.lut.intensity } } : {}) } })
  return { p, id }
}

const GRADE: Grade = { curves: { master: [[0, 0.1], [0.5, 0.6], [1, 0.9]] }, hsl: { blue: { h: 20, s: -40, l: 10 }, orange: { h: 0, s: 30, l: 0 } }, lut: { id: 'x', intensity: 40 } }

function expected(p: Project, grade: Grade, mix = 1): number[] {
  const px = new Uint8ClampedArray(FRAME)
  gradePixels(px, [{ grade: prepareGrade(grade, p.luts), mix }])
  return [...px]
}

function previewOf(p: Project) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return { root, r: new StageRenderer(root, p, { mode: 'preview', resolveUrl: (id, k) => `/api/media/${id}/${k}` }) }
}

describe('colour grades in the renderer (E-20)', () => {
  it('preview: draws the clip graded on a canvas over it and hides the plain picture', () => {
    const { p, id } = project(GRADE)
    const { root, r } = previewOf(p)
    r.render(0.5)
    const wrap = root.querySelector(`[data-ps-layer="${id}"]`)!
    const video = ready(wrap.querySelector('video')!)
    video.dispatchEvent(new Event('loadeddata'))
    const canvas = wrap.querySelector('canvas[data-ps-grade]') as HTMLCanvasElement & Px
    expect(canvas).toBeTruthy()
    expect(canvas.style.display).toBe('block')
    expect(video.style.opacity).toBe('0')
    // under the vignette/grain overlay, laid out like the media (crop included)
    expect(canvas.nextElementSibling?.hasAttribute('data-ps-overlay')).toBe(true)
    expect(canvas.style.width).toBe(video.style.width)
    expect([...canvas.__px!]).toEqual(expected(p, updateGradeOf(p, id)))
    r.destroy()
  })

  it('export: grades the frame HyperFrames injects, the same pixels as the preview', () => {
    const { p, id } = project(GRADE)
    const html = compileToHyperFrames(p, { assetPath: (a) => `assets/${a}.mp4`, runtimePath: 'runtime.js', gsapPath: 'gsap.min.js', fontFaceCss: '' })
    // the LUT travels inside the composition's project
    expect(html).toContain(p.luts![Object.keys(p.luts!)[0]].data.slice(0, 40))
    document.body.innerHTML = html.slice(html.indexOf('<div id="root"'), html.indexOf('<script>\n(function'))
    const stage = document.getElementById('stage')!
    const r = new StageRenderer(stage, p, { mode: 'export', resolveUrl: (a) => `assets/${a}.mp4` })
    r.render(0.5)
    const wrap = stage.querySelector(`[data-ps-layer="${id}"]`)!
    const video = wrap.querySelector('video')!
    expect(video.style.opacity).toBe('')
    // HyperFrames: the frame as an <img> after the video, copying its (zero) opacity, after the seek
    const frame = ready(document.createElement('img'))
    frame.className = '__render_frame__'
    frame.style.visibility = 'visible'
    video.after(frame)
    frame.dispatchEvent(new Event('load'))
    const canvas = wrap.querySelector('canvas[data-ps-grade]') as HTMLCanvasElement & Px
    expect(canvas.style.display).toBe('block')
    expect(video.style.opacity).toBe('0')
    const exportPx = [...canvas.__px!]
    expect(exportPx).toEqual(expected(p, updateGradeOf(p, id)))
    // and the next frame, injected after the next seek, is graded too
    ;(frame as unknown as Px).__px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])
    frame.setAttribute('src', 'data:image/png;base64,next')
    frame.dispatchEvent(new Event('load'))
    expect([...canvas.__px!].slice(0, 3)).not.toEqual(exportPx.slice(0, 3))
    r.destroy()

    // the preview draws the same pixels from the same frame
    const pv = previewOf(p)
    pv.r.render(0.5)
    const v = ready(pv.root.querySelector('video')!)
    v.dispatchEvent(new Event('loadeddata'))
    expect([...(pv.root.querySelector('canvas[data-ps-grade]') as HTMLCanvasElement & Px).__px!]).toEqual(exportPx)
    pv.r.destroy()
  })

  it('puts the plain picture back when the grade is taken off', () => {
    const { p, id } = project({ curves: { master: [[0, 1], [1, 0]] } })
    const { root, r } = previewOf(p)
    r.render(0.5)
    const video = ready(root.querySelector('video')!)
    video.dispatchEvent(new Event('loadeddata'))
    expect(video.style.opacity).toBe('0')
    r.setProject(updateItem<VideoItem>(p, id, { grade: undefined }))
    r.render(0.6)
    expect(video.style.opacity).toBe('')
    expect((root.querySelector('canvas[data-ps-grade]') as HTMLCanvasElement).style.display).toBe('none')
    r.destroy()
  })

  it('an adjustment layer filters everything beneath it and grades the clips beneath at its strength', () => {
    const { p: p0, id } = project({})
    const a = addAdjustmentLayer(p0, 0, 4)
    const grade: Grade = { curves: { master: [[0, 1], [1, 0]] } }
    const p = updateItem<AdjustmentItem>(a.project, a.id, { adjust: { ...(a.project.tracks.at(-1)!.items[0] as AdjustmentItem).adjust, saturation: -100 }, grade, opacity: 0.5 })
    const { root, r } = previewOf(p)
    // jsdom drops backdrop-filter from a style: record what the renderer writes
    const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText')!
    const written: string[] = []
    Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', { configurable: true, get: desc.get, set(v: string) { written.push(v); desc.set!.call(this, v) } })
    try {
      r.render(1)
    } finally {
      Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', desc)
    }
    const adj = root.querySelector(`[data-ps-layer="${a.id}"]`) as HTMLElement
    expect(written.some((css) => css.includes('backdrop-filter:saturate(0.000);') && css.includes('width:320.00px;height:180.00px'))).toBe(true)
    expect(adj.style.opacity).toBe('0.5')
    expect(Number(adj.style.zIndex)).toBeGreaterThan(Number((root.querySelector(`[data-ps-layer="${id}"]`) as HTMLElement).style.zIndex))
    const video = ready(root.querySelector('video')!)
    video.dispatchEvent(new Event('loadeddata'))
    expect([...(root.querySelector('canvas[data-ps-grade]') as HTMLCanvasElement & Px).__px!]).toEqual(expected(p, grade, 0.5))
    r.destroy()
  })

  it('a media host that refuses to share pixels leaves the clip ungraded in the preview, after one CORS retry', () => {
    const { p } = project({ curves: { master: [[0, 1], [1, 0]] } })
    const { root, r } = previewOf(p)
    r.render(0.5)
    const canvas = () => root.querySelector('canvas[data-ps-grade]') as HTMLCanvasElement & { __ctx?: { getImageData: () => never } }
    const video = ready(root.querySelector('video')!)
    // first draw builds the context; make reading it fail as a tainted canvas does
    video.dispatchEvent(new Event('loadeddata'))
    canvas().__ctx!.getImageData = () => {
      throw Object.assign(new Error('tainted'), { name: 'SecurityError' })
    }
    video.dispatchEvent(new Event('seeked'))
    expect(video.crossOrigin).toBe('anonymous')
    video.dispatchEvent(new Event('error'))
    expect(video.hasAttribute('crossorigin')).toBe(false)
    expect(video.style.opacity).toBe('')
    expect(root.querySelector('[data-ps-grade-blocked]')).toBeTruthy()
    r.destroy()
  })
})

function updateGradeOf(p: Project, id: string): Grade {
  return (mainTrack(p)!.items.find((i) => i.id === id) as VideoItem).grade!
}
