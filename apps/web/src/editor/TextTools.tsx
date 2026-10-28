// Text tab tools: styling single words, the effects library, shrink to fit, and a warning for characters the export
// can't draw.
import type { TextItem, TextSpan, TextStyle } from '@producer/core'
import { TEXT_EFFECTS, applyTextEffect, cleanSpans, glyphReport, isSafeColor, safeColor, styleTextRange, textWords, updateItem, type SpanPatch } from '@producer/core'
import clsx from 'clsx'
import { Bold, Italic, TriangleAlert, Underline, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ColorInput, Field, Section, Slider, Toggle } from './controls'
import { useEditor } from './store'
import './canvas-tools.css'

const S = () => useEditor.getState()

const live = (id: string) => {
  for (const t of S().project.tracks) for (const i of t.items) if (i.id === id && i.type === 'text') return i
  return undefined
}

function list(chars: string[]) {
  const shown = chars.slice(0, 12).join(' ')
  return chars.length > 12 ? `${shown} and ${chars.length - 12} more` : shown
}

/** What the export draws differently from the preview: missing characters, another font, system fonts. */
export function GlyphWarning({ item }: { item: TextItem }) {
  const r = useMemo(() => glyphReport(item.text, item.style.fontFamily), [item.text, item.style.fontFamily])
  if (!r.missing.length && !r.fallback.length && !r.system.length) return null
  return (
    <div className="tx-glyphs">
      {r.missing.length > 0 && (
        <p className="ed-note ed-note-warn" role="note">
          <TriangleAlert size={13} />
          <span>
            The export can't draw <b className="tx-chars">{list(r.missing)}</b>: no font it has includes {r.missing.length === 1 ? 'this character' : 'these characters'}, so {r.missing.length === 1 ? 'it comes' : 'they come'} out as empty boxes (this preview may use a font from your computer).
          </span>
        </p>
      )}
      {r.fallback.length > 0 && (
        <p className="ed-note" role="note">
          {item.style.fontFamily} has no <b className="tx-chars">{list(r.fallback)}</b>: {r.fallback.length === 1 ? 'it is' : 'they are'} drawn in Inter.
        </p>
      )}
      {r.system.length > 0 && <p className="ed-note" role="note">Emoji and Chinese, Japanese or Korean characters are drawn by the export's Noto fonts and can look a little different from this preview.</p>}
    </div>
  )
}

/** Shrink to fit: on, the text is drawn as large as fits its box (up to its size); the box height is set here or on the canvas. */
export function FitFields({ item, set }: { item: TextItem; set: (patch: Partial<TextStyle>, label: string, key?: string) => void }) {
  const H = useEditor((s) => s.project.height)
  const fit = item.style.fit
  const turnOn = (on: boolean) => {
    if (!on) return set({ fit: undefined }, 'Shrink to fit off')
    // start from the height the text has now
    const el = document.querySelector(`.cv-stage [data-ps-layer="${item.id}"]`) as HTMLElement | null
    const now = el?.offsetHeight || Math.round(item.style.fontSize * item.style.lineHeight * 2)
    set({ fit: { height: Math.max(20, Math.round(now)) } }, 'Shrink to fit')
  }
  return (
    <>
      <Field label="Fit">
        <Toggle checked={!!fit} onChange={turnOn} label={<span className="muted">Shrink to fit box</span>} />
      </Field>
      {fit && <Slider label="Box height" value={fit.height} min={20} max={Math.max(H * 2, fit.height)} step={1} suffix="px" onChange={(v) => set({ fit: { height: Math.round(v) } }, 'Text box height', 'fh')} />}
    </>
  )
}

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900]

function styleAt(spans: TextSpan[], at: number): Omit<TextSpan, 'start' | 'end'> {
  const s = spans.find((x) => at >= x.start && at < x.end)
  if (!s) return {}
  const { start: _a, end: _b, ...rest } = s
  return rest
}

/** Pick words (click; Shift+click for a run) and give them their own colour, weight, italic or underline. */
export function WordStyles({ item }: { item: TextItem }) {
  const words = useMemo(() => textWords(item.text), [item.text])
  const spans = useMemo(() => cleanSpans(item.spans, item.text.length), [item.spans, item.text])
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null)
  useEffect(() => setSel(null), [item.id])
  useEffect(() => {
    if (sel && Math.max(sel.a, sel.b) >= words.length) setSel(null)
  }, [sel, words.length])
  const lo = sel ? Math.min(sel.a, sel.b) : -1
  const hi = sel ? Math.max(sel.a, sel.b) : -1
  const range = sel && words[lo] && words[hi] ? { start: words[lo].start, end: words[hi].end } : null
  const cur = range ? styleAt(spans, range.start) : {}
  const apply = (patch: SpanPatch, label: string, coalesce?: string) => {
    if (!range) return
    const s = S()
    const p = styleTextRange(s.project, item.id, range.start, range.end, patch)
    if (p !== s.project) s.commit(p, label, coalesce ? { coalesce } : undefined)
  }
  const pick = (i: number, extend: boolean) => {
    if (extend && sel) setSel({ a: sel.a, b: i })
    else setSel(sel && sel.a === i && sel.b === i ? null : { a: i, b: i })
  }
  const bold = (cur.fontWeight ?? item.style.fontWeight) >= 700
  const italic = cur.italic ?? item.style.italic
  const underline = cur.underline ?? item.style.underline
  const label = range ? `“${item.text.slice(range.start, range.end)}”` : ''
  return (
    <Section title="Word styles">
      <p className="ed-note">Pick a word (Shift+click for several) to give it its own colour or weight.</p>
      <div className="tx-words" role="group" aria-label="Words">
        {words.map((w, i) => {
          const st = styleAt(spans, w.start)
          const on = i >= lo && i <= hi
          return (
            <button
              key={`${i}:${w.start}`}
              type="button"
              className={clsx('tx-word', on && 'on')}
              aria-pressed={on}
              style={{ color: isSafeColor(st.color) ? st.color : undefined, fontWeight: st.fontWeight, fontStyle: st.italic ? 'italic' : undefined, textDecoration: st.underline ? 'underline' : undefined }}
              onClick={(e) => pick(i, e.shiftKey)}
            >
              {w.w}
            </button>
          )
        })}
      </div>
      {range && (
        <div className="tx-wordctl" role="group" aria-label={`Style for ${label}`}>
          <Field label="Colour">
            <ColorInput value={cur.color ?? item.style.color} onChange={(v) => apply({ color: v }, 'Word colour', `wc:${item.id}:${range.start}:${range.end}`)} />
          </Field>
          <Field label="Weight">
            <select className="ed-select" value={cur.fontWeight ?? item.style.fontWeight} onChange={(e) => apply({ fontWeight: +e.target.value }, 'Word weight')}>
              {WEIGHTS.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </Field>
          <Field label="Style">
            <div className="row" style={{ gap: 4 }}>
              <button type="button" className={clsx('ed-iconbtn', bold && 'on')} aria-pressed={bold} title="Bold" aria-label="Bold" onClick={() => apply({ fontWeight: bold ? 400 : 800 }, 'Word weight')}><Bold size={14} /></button>
              <button type="button" className={clsx('ed-iconbtn', italic && 'on')} aria-pressed={italic} title="Italic" aria-label="Italic" onClick={() => apply({ italic: !italic }, 'Word italic')}><Italic size={14} /></button>
              <button type="button" className={clsx('ed-iconbtn', underline && 'on')} aria-pressed={underline} title="Underline" aria-label="Underline" onClick={() => apply({ underline: !underline }, 'Word underline')}><Underline size={14} /></button>
              <button type="button" className="btn sm" onClick={() => apply({ color: null, fontWeight: null, italic: null, underline: null }, 'Clear word style')}>
                <X size={12} /> Clear
              </button>
            </div>
          </Field>
        </div>
      )}
    </Section>
  )
}

/** A small "Aa" drawn with an effect, for its button. */
function previewStyle(style: TextStyle): React.CSSProperties {
  const k = 26 / Math.max(1, style.fontSize)
  const css: React.CSSProperties = { fontFamily: style.fontFamily, fontWeight: style.fontWeight, fontStyle: style.italic ? 'italic' : undefined, color: safeColor(style.color, '#ffffff') }
  if (style.stroke) (css as Record<string, string>).WebkitTextStroke = `${Math.max(0.6, style.stroke.width * k).toFixed(1)}px ${safeColor(style.stroke.color, '#000')}`
  const sh: string[] = []
  if (style.shadow) sh.push(`${(style.shadow.x * k).toFixed(1)}px ${(style.shadow.y * k).toFixed(1)}px ${(style.shadow.blur * k).toFixed(1)}px ${safeColor(style.shadow.color, 'transparent')}`)
  if (style.glow) sh.push(`0 0 ${(style.glow.blur * k).toFixed(1)}px ${safeColor(style.glow.color, 'transparent')}`)
  if (sh.length) css.textShadow = sh.join(', ')
  if (style.gradient) {
    css.backgroundImage = `linear-gradient(${style.gradient.angle}deg, ${safeColor(style.gradient.from, '#fff')}, ${safeColor(style.gradient.to, '#fff')})`
    ;(css as Record<string, string>).WebkitBackgroundClip = 'text'
    ;(css as Record<string, string>).WebkitTextFillColor = 'transparent'
  } else if (style.background) {
    css.background = safeColor(style.background.color, '#000')
    css.borderRadius = 4
    css.padding = '0 4px'
  }
  return css
}

export function TextEffectsSection({ item }: { item: TextItem }) {
  const apply = (id: string, name: string) => {
    const cur = live(item.id) ?? item
    const s = S()
    s.commit(updateItem<TextItem>(s.project, item.id, { style: applyTextEffect(cur.style, id), effect: id === 'plain' ? undefined : id }), `Text effect ${name}`)
  }
  return (
    <Section title="Effects">
      <div className="tx-fxgrid" role="group" aria-label="Text effects">
        {TEXT_EFFECTS.map((fx) => {
          const on = (item.effect ?? 'plain') === fx.id
          return (
            <button key={fx.id} type="button" className={clsx(on && 'on')} aria-pressed={on} onClick={() => apply(fx.id, fx.name)}>
              <span className="aa" style={previewStyle(applyTextEffect({ ...item.style, fontSize: 26 }, fx.id))}>Aa</span>
              <small>{fx.name}</small>
            </button>
          )
        })}
      </div>
    </Section>
  )
}
