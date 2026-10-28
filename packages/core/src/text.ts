// Text items: per-word styling (spans), editing the words without losing it, the markup the preview and the export
// draw, gradient fills, and the shrink-to-fit search the renderer runs.
import { clone, editable, findItem } from './ops'
import { scaleTextStyle } from './presets'
import type { Project, TextItem, TextSpan, TextStyle } from './types'
import { clamp, cssNumber, escapeHtml, safeColor } from './util'

type SpanStyle = Omit<TextSpan, 'start' | 'end'>
/** A style change for a range: a value sets it, null takes it off. */
export type SpanPatch = { [K in keyof SpanStyle]?: SpanStyle[K] | null }

const KEYS: Array<keyof SpanStyle> = ['color', 'fontWeight', 'italic', 'underline']

const sameStyle = (a: SpanStyle, b: SpanStyle) => KEYS.every((k) => a[k] === b[k])
const plain = (s: SpanStyle) => KEYS.every((k) => s[k] === undefined)

/** Spans inside 0..length, sorted, without overlaps or empty ones (stored documents are user data). */
export function cleanSpans(spans: TextSpan[] | undefined, length: number): TextSpan[] {
  if (!spans?.length) return []
  const out: TextSpan[] = []
  let at = 0
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const start = Math.max(at, clamp(Math.floor(cssNumber(s.start)), 0, length))
    const end = clamp(Math.floor(cssNumber(s.end)), 0, length)
    if (end <= start) continue
    out.push({ ...s, start, end })
    at = end
  }
  return out
}

/** Rebuild spans from one style per character, joining neighbours that look the same. */
function fromChars(chars: SpanStyle[]): TextSpan[] {
  const out: TextSpan[] = []
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (plain(c)) continue
    const last = out[out.length - 1]
    if (last && last.end === i && sameStyle(last, c)) last.end = i + 1
    else out.push({ ...c, start: i, end: i + 1 })
  }
  return out
}

function toChars(spans: TextSpan[] | undefined, length: number): SpanStyle[] {
  const chars: SpanStyle[] = Array.from({ length }, () => ({}))
  for (const s of cleanSpans(spans, length)) {
    const { start, end, ...style } = s
    for (let i = start; i < end; i++) chars[i] = { ...style }
  }
  return chars
}

/** Set (or with null, clear) styling on characters start..end of a text's spans. */
export function styleSpans(spans: TextSpan[] | undefined, length: number, start: number, end: number, patch: SpanPatch): TextSpan[] {
  const chars = toChars(spans, length)
  for (let i = Math.max(0, start); i < Math.min(length, end); i++) {
    const c = { ...chars[i] }
    for (const k of KEYS) {
      if (!(k in patch)) continue
      const v = patch[k]
      if (v === null || v === undefined) delete c[k]
      else (c as Record<string, unknown>)[k] = v
    }
    chars[i] = c
  }
  return fromChars(chars)
}

/** Style a range of a text item's characters (see styleSpans). */
export function styleTextRange(p0: Project, itemId: string, start: number, end: number, patch: SpanPatch): Project {
  const p = clone(p0)
  const f = findItem(p, itemId)
  if (!editable(f) || f.item.type !== 'text') return p0
  const spans = styleSpans(f.item.spans, f.item.text.length, start, end, patch)
  if (spans.length) f.item.spans = spans
  else delete f.item.spans
  p.updatedAt = Date.now()
  return p
}

/**
 * Spans for `next` after the text changed from `prev`: text before and after the edit keeps its styling, typing
 * inside a styled word carries that word's style, and styling on deleted text goes with it.
 */
export function remapSpans(prev: string, next: string, spans: TextSpan[] | undefined): TextSpan[] {
  if (!spans?.length || prev === next) return cleanSpans(spans, next.length)
  let a = 0
  const max = Math.min(prev.length, next.length)
  while (a < max && prev[a] === next[a]) a++
  let b = 0
  while (b < max - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++
  const oldChars = toChars(spans, prev.length)
  const inserted = next.length - a - b
  // typed text takes the style of what it replaced when that was one style, or of the word it carries on
  const replaced = oldChars.slice(a, prev.length - b)
  const typed = next.slice(a, a + inserted)
  const joined = a > 0 && /\S/.test(prev[a - 1]) && !/^\s/.test(typed)
  const carry = replaced.length && replaced.every((c) => sameStyle(c, replaced[0])) ? replaced[0] : joined ? oldChars[a - 1] : {}
  const chars = [...oldChars.slice(0, a), ...Array.from({ length: inserted }, () => ({ ...carry })), ...oldChars.slice(prev.length - b)]
  return fromChars(chars)
}

/** Change a text item's words, keeping its per-word styling where the words stayed. */
export function setTextContent(p0: Project, itemId: string, text: string): Project {
  const p = clone(p0)
  const f = findItem(p, itemId)
  if (!editable(f) || f.item.type !== 'text') return p0
  const it = f.item
  const spans = remapSpans(it.text, text, it.spans)
  it.text = text
  it.name = text.split('\n')[0].slice(0, 40) || 'Text'
  if (spans.length) it.spans = spans
  else delete it.spans
  p.updatedAt = Date.now()
  return p
}

/** The words of a text with their character offsets (for picking a range). */
export function textWords(text: string): Array<{ w: string; start: number; end: number }> {
  return [...text.matchAll(/\S+/g)].map((m) => ({ w: m[0], start: m.index!, end: m.index! + m[0].length }))
}

/** Inline CSS for a span (it lands in an HTML attribute: checked colours and plain numbers only). */
export function spanCss(s: SpanStyle): string {
  const css: string[] = []
  if (s.color !== undefined) {
    const c = safeColor(s.color, 'inherit')
    css.push(`color:${c}`, `-webkit-text-fill-color:${c}`)
  }
  if (s.fontWeight !== undefined) css.push(`font-weight:${clamp(Math.round(cssNumber(s.fontWeight, 400) / 100) * 100, 100, 900)}`)
  if (s.italic !== undefined) css.push(`font-style:${s.italic ? 'italic' : 'normal'}`)
  if (s.underline !== undefined) css.push(`text-decoration:${s.underline ? 'underline' : 'none'}`)
  return css.join(';')
}

const fmt = (s: string, upper: boolean) => escapeHtml(upper ? s.toUpperCase() : s).replace(/\n/g, '<br>')

/** The markup of a text item: its words with their spans, the first `count` characters only when given. */
export function textMarkup(it: Pick<TextItem, 'text' | 'spans' | 'style'>, count?: number): string {
  const upper = !!it.style.uppercase
  const spans = cleanSpans(it.spans, it.text.length)
  if (!spans.length) {
    // as it always was: the case changes first, then the typewriter counts characters
    const t = upper ? it.text.toUpperCase() : it.text
    return escapeHtml(count === undefined ? t : t.slice(0, count)).replace(/\n/g, '<br>')
  }
  const n = count === undefined ? it.text.length : Math.min(count, it.text.length)
  let out = ''
  let at = 0
  for (const s of spans) {
    if (s.start >= n) break
    if (s.start > at) out += fmt(it.text.slice(at, s.start), upper)
    const end = Math.min(s.end, n)
    out += `<span style="${escapeHtml(spanCss(s))}">${fmt(it.text.slice(s.start, end), upper)}</span>`
    at = end
  }
  if (at < n) out += fmt(it.text.slice(at, n), upper)
  return out
}

/** CSS that fills the letters with the style's gradient (on an inline wrapper inside the text box), or ''. */
export function textGradientCss(style: TextStyle): string {
  const g = style.gradient
  if (!g) return ''
  const from = safeColor(g.from, '#ffffff')
  const to = safeColor(g.to, '#ffffff')
  return `background:linear-gradient(${cssNumber(g.angle, 90)}deg, ${from}, ${to});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;box-decoration-break:clone;-webkit-box-decoration-break:clone`
}

/** A style drawn `k` times its size (font, spacing, outline, shadow, box padding); the box keeps its width. */
export function scaledTextStyle(style: TextStyle, k: number): TextStyle {
  const s = structuredClone(style)
  scaleTextStyle(s, k, Infinity)
  s.boxWidth = style.boxWidth
  return s
}

/**
 * The largest scale (lowest 0.05, at most 1) at which `fits(k)` holds: 1 when the text already fits, otherwise a
 * fixed number of halvings, so the preview and the export find the same size from the same measurements.
 */
export function fitScale(fits: (k: number) => boolean, steps = 12): number {
  if (fits(1)) return 1
  let lo = 0.05
  let hi = 1
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}
