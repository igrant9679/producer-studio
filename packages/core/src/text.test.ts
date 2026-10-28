// Text (E-19): per-word styling, effects, templates that fit the canvas, characters the export can't draw.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FONT_RANGES,
  FONTS,
  TEXT_EFFECTS,
  addItem,
  applyTextEffect,
  createProject,
  createTextItem,
  defaultTextStyle,
  evaluate,
  findItem,
  fitScale,
  glyphReport,
  remapSpans,
  setTextContent,
  styleSpans,
  styleTextRange,
  textInnerHtml,
  textMarkup,
  textWords,
  updateItem,
  type Project,
  type TextItem,
} from './index'

const style = defaultTextStyle()

describe('per-word styling', () => {
  it('styles a range, splits what it overlaps and joins what matches; null takes a style off', () => {
    let spans = styleSpans(undefined, 11, 6, 11, { color: '#ff0000' })
    expect(spans).toEqual([{ start: 6, end: 11, color: '#ff0000' }])
    spans = styleSpans(spans, 11, 0, 8, { fontWeight: 900 })
    expect(spans).toEqual([
      { start: 0, end: 6, fontWeight: 900 },
      { start: 6, end: 8, color: '#ff0000', fontWeight: 900 },
      { start: 8, end: 11, color: '#ff0000' },
    ])
    expect(styleSpans(spans, 11, 0, 11, { color: null, fontWeight: null })).toEqual([])
  })

  it('draws the words with their spans, cased and cut by the typewriter like the rest', () => {
    const it = { text: 'Hello big world', style, spans: [{ start: 6, end: 9, color: '#ff0000', fontWeight: 900 }] }
    expect(textMarkup(it)).toBe('Hello <span style="color:#ff0000;-webkit-text-fill-color:#ff0000;font-weight:900">big</span> world')
    expect(textMarkup({ ...it, style: { ...style, uppercase: true } }, 8)).toBe('HELLO <span style="color:#ff0000;-webkit-text-fill-color:#ff0000;font-weight:900">BI</span>')
    // a colour that isn't one is dropped, never written into the markup
    expect(textMarkup({ ...it, spans: [{ start: 0, end: 5, color: 'red;background:url(x)' }] })).toBe('<span style="color:inherit;-webkit-text-fill-color:inherit">Hello</span> big world')
    expect(textMarkup({ text: 'a<b', style })).toBe('a&lt;b')
  })

  it('editing the words keeps the styling where the words stayed', () => {
    const spans = [{ start: 6, end: 9, color: '#f00' }]
    // typed before: the styled word moves along
    expect(remapSpans('Hello big world', 'Oh, Hello big world', spans)).toEqual([{ start: 10, end: 13, color: '#f00' }])
    // typed inside the word: it stays one styled word
    expect(remapSpans('Hello big world', 'Hello bigger world', spans)).toEqual([{ start: 6, end: 12, color: '#f00' }])
    // typed after it, a new word is plain
    expect(remapSpans('Hello big world', 'Hello big new world', spans)).toEqual([{ start: 6, end: 9, color: '#f00' }])
    // the word replaced: the new one takes its style; deleted: the style goes with it
    expect(remapSpans('Hello big world', 'Hello huge world', spans)).toEqual([{ start: 6, end: 10, color: '#f00' }])
    expect(remapSpans('Hello big world', 'Hello world', spans)).toEqual([])
  })

  it('setTextContent and styleTextRange edit the document (not a locked one)', () => {
    let p: Project = addItem(createProject({ id: 'p' }), createTextItem(0, 'heading', { id: 't', text: 'Make it pop' }))
    const pop = textWords('Make it pop')[2]
    expect(pop).toEqual({ w: 'pop', start: 8, end: 11 })
    p = styleTextRange(p, 't', pop.start, pop.end, { color: '#35e0ff' })
    p = setTextContent(p, 't', 'Make it really pop')
    const t = findItem(p, 't')!.item as TextItem
    expect(t).toMatchObject({ text: 'Make it really pop', name: 'Make it really pop', spans: [{ start: 15, end: 18, color: '#35e0ff' }] })
    const html = evaluate(p, 1).layers.find((l) => l.itemId === 't')!.text!.html
    expect(html).toContain('<span style="color:#35e0ff;-webkit-text-fill-color:#35e0ff">pop</span>')
    const locked = updateItem<TextItem>(p, 't', { locked: true })
    expect(styleTextRange(locked, 't', 0, 4, { italic: true })).toBe(locked)
  })
})

describe('shrink to fit', () => {
  it("a fitted text's box has the fit's height; a typewriter measures the whole text", () => {
    let p: Project = addItem(createProject({ id: 'p' }), createTextItem(0, 'heading', { id: 't', text: 'Typing away' }))
    p = updateItem<TextItem>(p, 't', { style: { ...(findItem(p, 't')!.item as TextItem).style, fit: { height: 300 } }, animations: { in: { preset: 'typewriter', duration: 2 } } })
    const layer = evaluate(p, 1).layers.find((l) => l.itemId === 't')!
    expect(layer.box.height).toBe(300)
    expect(layer.text!.html).toBe('Typin')
    expect(layer.text!.full).toBe('Typing away')
    expect(evaluate(p, 2.5).layers.find((l) => l.itemId === 't')!.text!.full).toBeUndefined()
  })

  it('finds the largest scale that fits, the same way every time', () => {
    const fits = (k: number) => 72 * k * 2 <= 100
    const k = fitScale(fits)
    expect(fits(k)).toBe(true)
    expect(k).toBeGreaterThan(0.69)
    expect(k).toBe(fitScale(fits))
    expect(fitScale(() => true)).toBe(1)
    expect(fitScale(() => false)).toBe(0.05)
  })
})

describe('text effects', () => {
  it('are sized from the font size and replace the decoration the text had', () => {
    const big = { ...style, fontSize: 200 }
    const outlined = applyTextEffect({ ...big, glow: { color: '#fff', blur: 9 } }, 'outline')
    expect(outlined.stroke).toEqual({ color: '#000000', width: 12 })
    expect(outlined.glow).toBeUndefined()
    const sunset = applyTextEffect(outlined, 'gradient')
    expect(sunset.stroke).toBeUndefined()
    expect(sunset.gradient).toEqual({ from: '#ffd84d', to: '#ff4f8b', angle: 90 })
    expect(textInnerHtml(sunset, 'Hi')).toMatch(/^<span style="background:linear-gradient\(90deg, #ffd84d, #ff4f8b\);-webkit-background-clip:text.*">Hi<\/span>$/)
    // hollow letters get their fill back from the next effect
    expect(applyTextEffect(applyTextEffect(big, 'hollow'), 'shadow').color).toBe('#ffffff')
    expect(new Set(TEXT_EFFECTS.map((e) => e.id)).size).toBe(TEXT_EFFECTS.length)
  })
})

describe('templates adapt to the canvas', () => {
  it('a lower third sits low and left in landscape, higher in portrait, and fits the frame', () => {
    const wide = createTextItem(0, 'lower-third', {}, { width: 1920, height: 1080 })
    expect(wide.transform).toMatchObject({ x: -960 + 115 + 450, y: 324 })
    const tall = createTextItem(0, 'lower-third', {}, { width: 1080, height: 1920 })
    expect(tall.style.boxWidth).toBeLessThanOrEqual(972)
    expect(tall.transform.y).toBe(384)
    expect(tall.transform.x - tall.style.boxWidth / 2).toBeCloseTo(-540 + 65, 0)
    // a heading starts in the middle
    expect(createTextItem(0, 'heading', {}, { width: 1080, height: 1920 }).transform).toMatchObject({ x: 0, y: 0 })
  })
})

describe('characters the export can draw', () => {
  it('names what falls back to Inter, what the system fonts draw, and what comes out as boxes', () => {
    expect(glyphReport('Hello, world! 3×', 'Inter')).toEqual({ missing: [], fallback: [], system: [] })
    expect(glyphReport('Привет', 'Bebas Neue').fallback).toEqual([...'Привет'])
    expect(glyphReport('Привет', 'Montserrat').fallback).toEqual([])
    expect(glyphReport('你好 🎉', 'Inter')).toEqual({ missing: [], fallback: [], system: ['你', '好', '🎉'] })
    expect(glyphReport('مرحبا שלום', 'Inter').missing).toEqual([...'مرحباשלום'])
    // repeats are named once; joiners and variation selectors aren't characters of their own
    expect(glyphReport('ممم‍️', 'Inter').missing).toEqual(['م'])
  })

  it("the font table matches the installed fonts' unicode ranges", () => {
    const require = createRequire(import.meta.url)
    const faces: Record<string, number> = { Inter: 400, 'Space Grotesk': 500, 'JetBrains Mono': 400, Montserrat: 500, Poppins: 500, 'Playfair Display': 600, 'Bebas Neue': 400, Oswald: 500, 'Roboto Slab': 500, 'DM Serif Display': 400, Caveat: 600, 'IBM Plex Mono': 500 }
    expect(Object.keys(FONT_RANGES).sort()).toEqual([...FONTS].sort())
    for (const [family, weight] of Object.entries(faces)) {
      const dir = path.dirname(require.resolve(`@fontsource/${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/package.json`))
      const css = fs.readFileSync(path.join(dir, `${weight}.css`), 'utf8')
      const rs: Array<[number, number]> = []
      for (const m of css.matchAll(/unicode-range:\s*([^;]+);/g))
        for (const part of m[1].split(',')) {
          const [a, b] = part.trim().replace(/^U\+/i, '').split('-')
          rs.push([parseInt(a, 16), parseInt(b ?? a, 16)])
        }
      rs.sort((x, y) => x[0] - y[0])
      const merged: Array<[number, number]> = []
      for (const r of rs) {
        const last = merged[merged.length - 1]
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
        else merged.push([r[0], r[1]])
      }
      expect(FONT_RANGES[family], family).toBe(merged.map(([a, b]) => (a === b ? a.toString(16) : `${a.toString(16)}-${b.toString(16)}`)).join(','))
    }
  })
})
