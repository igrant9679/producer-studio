// @vitest-environment jsdom
// The renderer's text (E-19): shrink to fit, gradients, per-word spans and font loading, the same in both modes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addItem, applyTextEffect, createProject, createTextItem, findItem, styleTextRange, updateItem, type Project, type TextItem } from './index'
import { StageRenderer } from './runtime'

/** jsdom has no layout: a text's content is as tall as two lines of its font size, and fits its width. */
function fakeLayout() {
  const P = HTMLElement.prototype
  Object.defineProperty(P, 'scrollHeight', { configurable: true, get(this: HTMLElement) { return (parseFloat(this.style.fontSize) || 0) * 2 } })
  Object.defineProperty(P, 'scrollWidth', { configurable: true, get: () => 0 })
}

let fonts: EventTarget & { load: ReturnType<typeof vi.fn> }
beforeEach(() => {
  fakeLayout()
  fonts = Object.assign(new EventTarget(), { load: vi.fn(() => Promise.resolve([])) })
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
})
afterEach(() => {
  document.body.innerHTML = ''
})

function project(fit?: number): Project {
  let p = addItem(createProject({ id: 'p' }), createTextItem(0, 'heading', { id: 't', text: 'Fit me' }))
  const st = (findItem(p, 't')!.item as TextItem).style
  p = updateItem<TextItem>(p, 't', { style: { ...st, fontSize: 72, fit: fit ? { height: fit } : undefined } })
  return p
}

function draw(p: Project, mode: 'preview' | 'export', t = 1) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const r = new StageRenderer(root, p, { mode, resolveUrl: () => '' })
  r.render(t)
  const content = root.querySelector('[data-ps-layer="t"] [data-ps-content]') as HTMLElement
  return { r, root, content }
}

describe('shrink to fit in the renderer', () => {
  it('draws the text as large as fits the box, the same in the preview and the export', () => {
    const p = project(100)
    const a = draw(p, 'preview')
    const b = draw(p, 'export')
    const size = parseFloat(a.content.style.fontSize)
    // two lines of it fit 100 px: about 50 px, not the 72 it asks for
    expect(size).toBeGreaterThan(49)
    expect(size).toBeLessThanOrEqual(50.25)
    expect(b.content.style.fontSize).toBe(a.content.style.fontSize)
    // centred in its fixed-height box, words kept whole
    expect((a.root.querySelector('[data-ps-layer="t"]') as HTMLElement).style.height).toBe('100px')
    expect(a.content.style.cssText).toContain('overflow-wrap: normal')
    a.r.destroy()
    b.r.destroy()
  })

  it('text that already fits keeps its size; without a fit nothing changes', () => {
    expect(draw(project(400), 'preview').content.style.fontSize).toBe('72px')
    const plain = draw(project(), 'preview')
    expect(plain.content.style.fontSize).toBe('72px')
    expect(plain.content.style.position).toBe('relative')
  })

  it('asks for the fonts the text uses up front, and measures again when one arrives', () => {
    let p = project(100)
    p = styleTextRange(p, 't', 0, 3, { fontWeight: 900 })
    const { content } = draw(p, 'preview')
    const asked = fonts.load.mock.calls.map((c) => c[0])
    expect(asked).toContain('800 16px "Inter"')
    expect(asked).toContain('900 16px "Inter"')
    // a font arrived: drawn again (here it measures the same)
    content.innerHTML = ''
    fonts.dispatchEvent(new Event('loadingdone'))
    expect(content.innerHTML).toContain('Fit')
  })
})

describe('text effects and word styles in the renderer', () => {
  it('a gradient fills the letters inside the background pill, and a word keeps its own colour', () => {
    let p = project()
    const st = (findItem(p, 't')!.item as TextItem).style
    p = updateItem<TextItem>(p, 't', { style: { ...applyTextEffect(st, 'gradient'), background: { color: '#000000', radius: 8, padding: 10, opacity: 1 } } })
    p = styleTextRange(p, 't', 4, 6, { color: '#00ff00' })
    const { content } = draw(p, 'export')
    const pill = content.firstElementChild as HTMLElement
    expect(pill.getAttribute('style')).toContain('border-radius:8px')
    const fill = pill.firstElementChild as HTMLElement
    expect(fill.getAttribute('style')).toContain('background-clip:text')
    expect(fill.innerHTML).toBe('Fit <span style="color:#00ff00;-webkit-text-fill-color:#00ff00">me</span>')
  })
})
