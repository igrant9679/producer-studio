// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { addAsset, addItem, compileToHyperFrames, createProject, createVideoItem, mainTrack, type Asset, type Project } from './index'
import { StageRenderer } from './runtime'

const asset = (id: string, duration = 10): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration, width: 1920, height: 1080, hasAudio: true })

/** A 1 s crossfade into a clip that starts at its source's first frame: the whole 0.5 s pre-roll holds that frame. */
function crossfadeIntoSourceStart(): { p: Project; b: string } {
  let p = createProject()
  p = addAsset(p, asset('a'))
  p = addAsset(p, asset('b', 6))
  p = addItem(p, createVideoItem(p.assets.a, 0, { transitionOut: { type: 'crossfade', duration: 1 } }))
  p = addItem(p, createVideoItem(p.assets.b, 999, { crop: { left: 0.1, right: 0, top: 0, bottom: 0 }, background: { type: 'blur', amount: 20 } }))
  return { p, b: mainTrack(p)!.items[1].id }
}

describe('export renderer', () => {
  it("shows the held first frame until the incoming clip's file starts (PIP-5 / EDT-3)", () => {
    const { p, b } = crossfadeIntoSourceStart()
    const html = compileToHyperFrames(p, { assetPath: (id) => `assets/${id}.mp4`, holdFramePath: (id) => `stills/${id}-hold.png`, runtimePath: 'runtime.js', gsapPath: 'gsap.min.js', fontFaceCss: '' })
    document.body.innerHTML = html.slice(html.indexOf('<div id="root"'), html.indexOf('<script>\n(function'))
    const stage = document.getElementById('stage')!
    const renderer = new StageRenderer(stage, p, { mode: 'export', resolveUrl: (id) => `assets/${id}.mp4` })
    const holds = [...stage.querySelectorAll<HTMLImageElement>('[data-ps-hold]')]
    expect(holds.map((h) => h.closest('[data-ps-layer],[data-ps-bg]')!.getAttribute('data-ps-layer') ?? 'bg')).toEqual([b, 'bg'])
    const shown = () => holds.map((h) => h.style.display)
    renderer.render(9.7)
    expect(shown()).toEqual(['block', 'block'])
    expect(holds[0].style.width).toBe('100%')
    renderer.render(10.2)
    expect(shown()).toEqual(['none', 'none'])
    renderer.render(9.9)
    expect(shown()).toEqual(['block', 'block'])
  })
})
