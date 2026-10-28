// @vitest-environment jsdom
// Masks, chroma key and processed copies (E-21): the document ops, what evaluate hands the renderer, and that the
// preview and the export renderer draw a masked, keyed clip the same way.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEY,
  addAsset,
  addItem,
  applyProcessedCopy,
  clipSourceRange,
  compileToHyperFrames,
  createImageItem,
  createProject,
  createTextItem,
  createVideoItem,
  defaultMask,
  evaluate,
  findItem,
  insertTrack,
  keyFilterMarkup,
  keyPixel,
  mainTrack,
  maskAt,
  maskImage,
  pasteKeyframes,
  copyKeyframes,
  pathMask,
  readMaskProp,
  separateAudio,
  setChromaKey,
  setItemSpeed,
  setKeyframe,
  setMask,
  splitItem,
  writeMaskProp,
  type Asset,
  type Project,
  type VideoItem,
} from './index'
import { StageRenderer } from './runtime'
import { keyFilterId } from './smartRuntime'

const video = (id: string, duration = 10, over: Partial<Asset> = {}): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration, width: 1920, height: 1080, hasAudio: true, ...over })

function oneClip(): { p: Project; id: string } {
  let p = createProject()
  p = addAsset(p, video('a'))
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va', duration: 4 }))
  return { p, id: 'va' }
}

const clip = (p: Project, id = 'va') => findItem(p, id)!.item as VideoItem

/** The SVG inside a layer's mask-image. */
const svgOf = (css: string) => decodeURIComponent(/data:image\/svg\+xml,([^"]+)/.exec(css)![1])

describe('masks', () => {
  it('puts a rectangle, ellipse or drawn path on a picture and takes it off again', () => {
    const { p, id } = oneClip()
    const rect = setMask(p, id, { ...defaultMask('rect'), radius: 0.5 })
    expect(clip(rect).mask).toMatchObject({ shape: 'rect', x: 0.5, width: 0.6, radius: 0.5, invert: false })
    expect(clip(setMask(rect, id, defaultMask('ellipse'))).mask!.shape).toBe('ellipse')
    // a drawn path: its box is the points' bounds, the points kept relative to it
    const path = pathMask([[0.1, 0.2], [0.5, 0.2], [0.3, 0.6]])!
    expect(path).toMatchObject({ shape: 'path', x: 0.3, y: 0.4, width: 0.4, height: 0.4 })
    expect(path.points).toEqual([[-0.5, -0.5], [0.5, -0.5], [0, 0.5]])
    expect(pathMask([[0, 0], [1, 1]])).toBeNull()
    const off = setMask(rect, id, undefined)
    expect(clip(off).mask).toBeUndefined()
    // text and shapes have no mask
    const t = addItem(p, createTextItem(0, 'title-serif', { id: 'tt' }))
    expect(setMask(t, 'tt', defaultMask('rect'))).toBe(t)
  })

  it('keyframes its place, size, rotation, feather and expansion, and drops them with the mask', () => {
    const { p: p0, id } = oneClip()
    let p = setMask(p0, id, defaultMask('ellipse'))
    // no keyframes yet: writing sets the mask itself
    p = writeMaskProp(p, id, 'maskX', 0.3, 1)
    expect(clip(p).mask!.x).toBe(0.3)
    // with keyframes, writing at a time sets the keyframe there
    p = setKeyframe(p, id, 'maskX', 0, 0.2, 'linear')
    p = writeMaskProp(p, id, 'maskX', 0.8, 2)
    expect(clip(p).keyframes.maskX!.map((k) => [k.t, k.value])).toEqual([[0, 0.2], [2, 0.8]])
    expect(readMaskProp(clip(p), 'maskX', 1)).toBeCloseTo(0.5, 5)
    expect(maskAt(clip(p), 1)!.x).toBeCloseTo(0.5, 5)
    // the keyframes travel with the clip like its others: a split keeps each half's curve, speed scales the times
    const half = splitItem(p, id, 1)
    expect(readMaskProp(clip(half.project, half.rightId!), 'maskX', 0)).toBeCloseTo(0.5, 5)
    const fast = setItemSpeed(p, id, 2)
    expect(clip(fast).keyframes.maskX!.map((k) => k.t)).toEqual([0, 1])
    // copied and pasted with the clip's other keyframes
    const copied = copyKeyframes(clip(p))!
    expect(Object.keys(copied.keyframes)).toContain('maskX')
    const other = addItem(setMask(p, id, clip(p).mask), createVideoItem(p.assets.a, 5, { id: 'vb', duration: 3 }))
    const withMask = setMask(other, 'vb', defaultMask('rect'))
    expect(clip(pasteKeyframes(withMask, 'vb', copied, 0), 'vb').keyframes.maskX).toHaveLength(2)
    // a clip without a mask takes no mask keyframes
    expect(clip(pasteKeyframes(other, 'vb', copied, 0), 'vb').keyframes.maskX).toBeUndefined()
    // taking the mask off takes its keyframes too
    expect(clip(setMask(p, id, undefined)).keyframes.maskX).toBeUndefined()
  })

  it('draws the mask as an SVG image the size of the layer box: feather blurs, expansion strokes, invert flips', () => {
    const m = { ...defaultMask('rect'), x: 0.25, y: 0.5, width: 0.5, height: 0.5, rotation: 30, feather: 20, expand: 6 }
    const svg = svgOf(maskImage(m, 1000, 500))
    expect(svg).toContain("width='1000' height='500'")
    expect(svg).toContain("translate(250 250) rotate(30)")
    expect(svg).toContain("<rect x='-250' y='-125' width='500' height='250' fill='white' stroke='white' stroke-width='12'")
    expect(svg).toContain("<feGaussianBlur stdDeviation='10'/>")
    // shrinking strokes in the background colour; inverted, the shape is black on white
    expect(svgOf(maskImage({ ...m, expand: -4 }, 1000, 500))).toContain("fill='white' stroke='black' stroke-width='8'")
    const inv = svgOf(maskImage({ ...m, invert: true, feather: 0 }, 1000, 500))
    expect(inv).toContain("fill='white'/><g transform")
    expect(inv).toContain("fill='black' stroke='black'")
    expect(inv).not.toContain('feGaussianBlur')
    expect(svgOf(maskImage(defaultMask('ellipse'), 100, 100))).toContain("<ellipse cx='0' cy='0' rx='30' ry='30'")
    expect(svgOf(maskImage(defaultMask('path'), 100, 100))).toContain("<path d='M0 -30 L30 0 L0 30 L-30 0 Z'")
  })

  it("hands the renderer the mask at the frame's time, sized to the clip's box", () => {
    const { p: p0, id } = oneClip()
    let p = setMask(p0, id, defaultMask('rect'))
    p = setKeyframe(p, id, 'maskWidth', 0, 0.2, 'linear')
    p = setKeyframe(p, id, 'maskWidth', 2, 0.6, 'linear')
    const at = (t: number) => evaluate(p, t).layers.find((l) => l.itemId === id)!
    expect(at(0).smart!.mask).toBeDefined()
    // the default canvas is 1920 × 1080 and the clip fills it: 0.4 × 1920 wide at 1 s
    expect(svgOf(at(1).smart!.mask!)).toContain("width='768'")
    // no mask, no key: nothing extra on the layer
    expect(evaluate(p0, 1).layers[0].smart).toBeUndefined()
  })
})

describe('chroma key', () => {
  it('turns the key colour transparent, keeps colours far from it and softens the edge between', () => {
    const k = { ...DEFAULT_KEY, color: '#00ff00', tolerance: 30, softness: 20, spill: 0 }
    expect(keyPixel(0, 255, 0, k).a).toBe(0)
    // greens a little off it (uneven light on the screen) key too
    expect(keyPixel(10, 230, 20, k).a).toBe(0)
    expect(keyPixel(40, 255, 60, k).a).toBe(0)
    // skin, white, grey, red, blue stay
    for (const c of [[224, 172, 140], [255, 255, 255], [128, 128, 128], [220, 30, 30], [30, 60, 220]]) expect(keyPixel(c[0], c[1], c[2], k).a, String(c)).toBe(1)
    // somewhere between green and grey the edge is partly transparent
    const mids = [60, 80, 100, 120].map((g) => keyPixel(128 - g / 2, 128 + g, 128 - g / 2, k).a)
    expect(mids.some((a) => a > 0 && a < 1)).toBe(true)
    // more tolerance keys more
    const wide = { ...k, tolerance: 80 }
    expect(keyPixel(90, 200, 90, wide).a).toBeLessThan(keyPixel(90, 200, 90, k).a)
  })

  it('takes the green tint off what remains with spill suppression', () => {
    const tinted = [150, 190, 140] as const
    const k = { color: '#00ff00', tolerance: 10, softness: 10, spill: 0 }
    const plain = keyPixel(...tinted, k)
    const cleaned = keyPixel(...tinted, { ...k, spill: 100 })
    expect(plain.a).toBe(1)
    expect(cleaned.g).toBeLessThan(plain.g)
    expect(cleaned.r).toBe(plain.r)
    // a neutral grey has no tint to take off
    expect(keyPixel(128, 128, 128, { ...k, spill: 100 })).toEqual(keyPixel(128, 128, 128, k))
  })

  it('builds one sRGB filter with the key, the matte table and the spill step', () => {
    const f = keyFilterMarkup('ps-key-va', { ...DEFAULT_KEY, spill: 50 })
    expect(f).toMatch(/^<filter id="ps-key-va" [^>]*color-interpolation-filters="sRGB">/)
    expect(f.match(/<feColorMatrix/g)).toHaveLength(4)
    expect(f).toContain('<feFuncA type="table" tableValues="0 ')
    expect(f).toContain('operator="arithmetic" k1="0" k2="1" k3="1" k4="-1"')
    expect(f.endsWith('<feComposite in="clean" in2="matte" operator="in"/></filter>')).toBe(true)
    expect(keyFilterMarkup('x', { ...DEFAULT_KEY, spill: 0 })).not.toContain('result="clean"')
  })

  it('is set, cleaned and removed on a clip', () => {
    const { p, id } = oneClip()
    const on = setChromaKey(p, id, { color: '#0047BB', tolerance: 250 })
    expect(clip(on).chromaKey).toEqual({ color: '#0047bb', tolerance: 100, softness: DEFAULT_KEY.softness, spill: DEFAULT_KEY.spill })
    expect(evaluate(on, 1).layers[0].smart!.key!.color).toBe('#0047bb')
    expect(clip(setChromaKey(on, id, undefined)).chromaKey).toBeUndefined()
  })
})

describe('preview and export draw masks and keys alike', () => {
  function project(): Project {
    let p = createProject()
    p = addAsset(p, video('a'))
    p = addAsset(p, { id: 'img', kind: 'image', name: 'logo.png', src: 'logo.png', width: 400, height: 400 })
    p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va', duration: 4, crop: { left: 0.1, right: 0, top: 0, bottom: 0 } }))
    const over = insertTrack(p, 'overlay')
    p = addItem(p, createImageItem(p.assets.img, 0, { id: 'im', duration: 4 }), over.id)
    p = setMask(p, 'va', { ...defaultMask('ellipse'), feather: 12, invert: true })
    p = setChromaKey(p, 'va', DEFAULT_KEY)
    p = setMask(p, 'im', pathMask([[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]])!)
    return p
  }

  function exportStage(p: Project) {
    const html = compileToHyperFrames(p, { assetPath: (id) => `assets/${id}`, runtimePath: 'runtime.js', gsapPath: 'gsap.min.js', fontFaceCss: '' })
    document.body.innerHTML = html.slice(html.indexOf('<div id="root"'), html.indexOf('<script>\n(function'))
    const stage = document.getElementById('stage')!
    return { stage, r: new StageRenderer(stage, p, { mode: 'export', resolveUrl: (id) => `assets/${id}` }) }
  }

  function previewStage(p: Project) {
    const root = document.createElement('div')
    document.body.appendChild(root)
    return { stage: root, r: new StageRenderer(root, p, { mode: 'preview', resolveUrl: (id) => `/api/media/${id}` }) }
  }

  // jsdom's style object drops CSS it doesn't know (masks): keep what the renderer asked each element for
  const asked = new WeakMap<CSSStyleDeclaration, string>()
  const cssText = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText')!
  Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
    configurable: true,
    get(this: CSSStyleDeclaration) { return cssText.get!.call(this) },
    set(this: CSSStyleDeclaration, v: string) { asked.set(this, v); cssText.set!.call(this, v) },
  })
  const declared = (el: HTMLElement, prop: string) => new RegExp(`(?:^|;)${prop}:(url\\("[^"]*"\\)|[^;]*)`).exec(asked.get(el.style) ?? '')?.[1] ?? ''

  /** What decides the picture: the wrapper's mask, the picture's filter and the filter it points at. */
  function look(stage: HTMLElement, id: string) {
    const wrap = stage.querySelector(`[data-ps-layer="${id}"]`) as HTMLElement
    const media = wrap.querySelector('[data-ps-content]') as HTMLElement
    const fid = keyFilterId(id)
    return {
      mask: declared(wrap, 'mask-image'),
      webkitMask: declared(wrap, '-webkit-mask-image'),
      maskSize: declared(wrap, 'mask-size'),
      filter: media.style.filter,
      keyFilter: stage.querySelector(`svg[data-ps-keys] #${fid}`)?.outerHTML ?? null,
    }
  }

  it('the same mask and key filter in both, at every time, and none once taken off', () => {
    const p = project()
    const ex = exportStage(p)
    const times = [0, 1.25, 3.5]
    const exported = times.map((t) => (ex.r.render(t), [look(ex.stage, 'va'), look(ex.stage, 'im')]))
    document.body.innerHTML = ''
    const pv = previewStage(p)
    const previewed = times.map((t) => (pv.r.render(t), [look(pv.stage, 'va'), look(pv.stage, 'im')]))
    expect(previewed).toEqual(exported)
    const [va, im] = exported[1]
    expect(va.mask).toContain('data:image/svg+xml')
    expect(va.filter).toContain(keyFilterId('va'))
    expect(va.keyFilter).toContain('feComponentTransfer')
    expect(im.mask).toContain('%3Cpath')
    expect(im.filter).toBe('')
    // the filter in the page is the one the core builds
    expect(va.keyFilter!.replace(/\s+/g, ' ')).toContain('color-interpolation-filters="sRGB"')
    // taken off: no mask, no filter
    pv.r.setProject(setChromaKey(setMask(p, 'va', undefined), 'va', undefined))
    pv.r.render(1)
    expect(look(pv.stage, 'va')).toMatchObject({ mask: '', filter: '' })
    expect(va.webkitMask).toBe(va.mask)
    expect(va.maskSize).toBe('100% 100%')
    pv.r.destroy()
  })
})

describe('processed copies', () => {
  it("covers the part of the file the clip shows, with a second either side, inside the file", () => {
    const { p, id } = oneClip()
    const moved = clip(p)
    expect(clipSourceRange({ ...moved, in: 3 }, 1, 10)).toEqual({ from: 2, to: 8 })
    expect(clipSourceRange({ ...moved, in: 0.4, speed: 2, duration: 4 }, 1, 6)).toEqual({ from: 0, to: 6 })
    expect(clipSourceRange({ ...moved, freezeAt: 5 }, 1)).toEqual({ from: 0, to: 6 })
    // a ramped clip covers the stretch it plays, not its average speed times its length
    const ramp = [{ t: 0, v: 0.5 }, { t: 4, v: 0.5 }, { t: 4.001, v: 2 }, { t: 8, v: 2 }]
    expect(clipSourceRange({ ...moved, in: 1, speed: 1, duration: 8, speedRamp: ramp }, 0)?.to).toBeCloseTo(1 + 2 + 8, 1)
  })

  it('swaps a copy that starts later in the file in, the clip showing the same frames, in one step', () => {
    let p = createProject()
    p = addAsset(p, video('a', 30))
    p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va', in: 10, duration: 4 }))
    p = separateAudio(p, 'va')
    const copy = video('stab', 6.5, { name: 'a.mp4 (stabilised)' })
    const r = applyProcessedCopy(p, 'va', copy, 9)
    const v = clip(r.project)
    expect(v.assetId).toBe('stab')
    expect(v.in).toBe(1)
    expect(v.duration).toBe(4)
    // its separated sound moved with it
    const sound = mainTrack(r.project) && r.project.tracks.flatMap((t) => t.items).find((x) => x.type === 'audio')!
    expect(sound).toMatchObject({ assetId: 'stab', in: 1 })
    // nothing else changed: the rest of the document is the same
    expect(r.project.assets.a).toEqual(p.assets.a)
    // a copy without sound leaves the separated sound on the original file
    const mute = applyProcessedCopy(p, 'va', video('bg', 6.5, { hasAudio: false }), 9)
    expect(mute.project.tracks.flatMap((t) => t.items).find((x) => x.type === 'audio')).toMatchObject({ assetId: 'a', in: 10 })
    // refused like Replace media
    expect(applyProcessedCopy(p, 'va', { ...copy, kind: 'audio' }, 9).refused).toBe('kind')
  })
})

