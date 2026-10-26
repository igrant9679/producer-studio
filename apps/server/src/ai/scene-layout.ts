// Motion text and diagrams as timeline items: the editor's own shapes and text, laid out for the canvas and revealed as
// the narration names each part. Editable afterwards, on brand (look + brand kit), identical in preview and export.
import { createShapeItem, createTextItem, round, type Item, type ItemAnimations, type SceneDiagram, type TextStyle } from '@producer/core'
import { type Palette, headlineStyle, labelStyle, onColor } from '../services/looks'

/** A built element: which layer stack it goes in (shapes below text) and the item itself. */
export interface Placed {
  layer: 'shape' | 'text'
  item: Item
}

export interface SceneFrame {
  /** Scene start on the timeline, its length, and when the voice starts (all seconds). */
  start: number
  duration: number
  voiceStart: number
  voiceDuration: number
  /** Word timings of the scene's voice (seconds from the voice start), to reveal parts as they are said. */
  words: Array<{ w: string; start: number }>
  width: number
  height: number
  pal: Palette
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'your', 'our', 'their', 'its', 'is', 'are', 'by', 'from', 'at', 'as', 'it', 'this', 'that'])
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%$]+/g, '')

/**
 * When each label should appear: as the narration first says it (its first meaningful word, in order), else spread
 * evenly through the voice. Absolute timeline seconds, never before the scene settles, never bunched together.
 */
export function revealTimes(labels: string[], f: SceneFrame): number[] {
  const n = labels.length
  const settle = f.start + 0.6
  const lastAt = f.start + f.duration - 1.2
  const even = (i: number) => f.voiceStart + f.voiceDuration * (0.12 + (0.7 * i) / Math.max(1, n - 1))
  const out: number[] = []
  let from = 0
  let prev = settle - 0.4
  labels.forEach((text, i) => {
    const keys = text.split(/\s+/).map(norm).filter((k) => k.length > 1 && !STOP.has(k))
    let at: number | undefined
    for (let wi = from; keys.length && wi < f.words.length; wi++) {
      const w = norm(f.words[wi].w)
      if (w && keys.some((k) => w === k || (k.length > 4 && w.startsWith(k.slice(0, 5))))) {
        at = f.voiceStart + f.words[wi].start - 0.15
        from = wi + 1
        break
      }
    }
    let t = at ?? even(i)
    t = Math.min(Math.max(t, prev + 0.35, settle), lastAt)
    out.push(round(t, 3))
    prev = t
  })
  return out
}

const out_ = { preset: 'fade' as const, duration: 0.3 }
const pop = (d = 0.45): ItemAnimations => ({ in: { preset: 'pop', duration: d }, out: out_ })
const rise = (d = 0.5): ItemAnimations => ({ in: { preset: 'rise', duration: d }, out: out_ })
const fadeIn = (d = 0.5): ItemAnimations => ({ in: { preset: 'fade', duration: d }, out: out_ })
const wipe = (d = 0.5): ItemAnimations => ({ in: { preset: 'wipeRight', duration: d }, out: out_ })

/** Visible from `at` to the scene's end. */
function until(f: SceneFrame, at: number) {
  return { start: round(at, 4), duration: round(Math.max(0.4, f.start + f.duration - at), 3) }
}

interface BoxOpts {
  name: string
  x: number
  y: number
  w: number
  h: number
  fill: string
  radius?: number
  shape?: 'rect' | 'ellipse'
  stroke?: { color: string; width: number }
  anim?: ItemAnimations
  opacity?: number
  /** Looping drift for decorative shapes. */
  float?: number
}

function box(f: SceneFrame, at: number, o: BoxOpts): Placed {
  return {
    layer: 'shape',
    item: createShapeItem(0, {
      ...until(f, at),
      name: o.name,
      shape: o.shape ?? 'rect',
      width: Math.round(o.w),
      height: Math.round(o.h),
      fill: o.fill,
      radius: Math.round(o.radius ?? 0),
      ...(o.stroke ? { stroke: o.stroke } : {}),
      opacity: o.opacity ?? 1,
      transform: { x: round(o.x, 1), y: round(o.y, 1), scale: 1, rotation: 0 },
      animations: { ...(o.anim ?? pop()), ...(o.float ? { combo: { preset: 'float' as const, period: o.float } } : {}) },
    }),
  }
}

function line(f: SceneFrame, at: number, o: { name: string; x1: number; y1: number; x2: number; y2: number; color: string; thick: number; anim?: ItemAnimations }): Placed {
  const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1)
  const angle = (Math.atan2(o.y2 - o.y1, o.x2 - o.x1) * 180) / Math.PI
  return {
    layer: 'shape',
    item: createShapeItem(0, {
      ...until(f, at),
      name: o.name,
      shape: 'line',
      width: Math.round(len),
      height: Math.max(2, Math.round(o.thick)),
      fill: o.color,
      radius: 0,
      transform: { x: round((o.x1 + o.x2) / 2, 1), y: round((o.y1 + o.y2) / 2, 1), scale: 1, rotation: round(angle, 2) },
      animations: o.anim ?? fadeIn(0.4),
    }),
  }
}

function label(f: SceneFrame, at: number, o: { text: string; x: number; y: number; style: TextStyle; anim?: ItemAnimations }): Placed {
  return {
    layer: 'text',
    item: createTextItem(0, 'heading', {
      ...until(f, at),
      name: o.text.slice(0, 40),
      text: o.text,
      style: o.style,
      transform: { x: round(o.x, 1), y: round(o.y, 1), scale: 1, rotation: 0 },
      animations: o.anim ?? rise(),
    }),
  }
}

/** Text styles for diagrams, scaled to the canvas. */
function styles(f: SceneFrame) {
  const s = Math.min(f.width, f.height) / 1080
  const { pal } = f
  const onAccent = onColor(pal.accent)
  return {
    s,
    node: (size: number, w: number, over: Partial<TextStyle> = {}) =>
      headlineStyle(pal, f.width, Math.round(size * s), { color: onAccent, letterSpacing: 0, lineHeight: 1.1, boxWidth: Math.round(w), ...over }),
    ink: (size: number, w: number, over: Partial<TextStyle> = {}) =>
      headlineStyle(pal, f.width, Math.round(size * s), { fontFamily: pal.bodyFont, fontWeight: 600, letterSpacing: 0, lineHeight: 1.2, boxWidth: Math.round(w), ...over }),
    accent: (size: number, w: number, over: Partial<TextStyle> = {}) => labelStyle(pal, f.width, Math.round(size * s), { boxWidth: Math.round(w), ...over }),
  }
}

/** Soft accent shapes drifting behind a text-only scene, so the frame still moves. */
export function ambience(f: SceneFrame): Placed[] {
  const r = Math.max(f.width, f.height) * 0.42
  return [
    box(f, f.start, { name: 'Glow', shape: 'ellipse', x: f.width * 0.32, y: -f.height * 0.28, w: r, h: r, fill: f.pal.accent, opacity: 0.1, anim: fadeIn(0.8), float: 7 }),
    box(f, f.start, { name: 'Glow', shape: 'ellipse', x: -f.width * 0.36, y: f.height * 0.34, w: r * 0.7, h: r * 0.7, fill: f.pal.accent, opacity: 0.07, anim: fadeIn(0.8), float: 9 }),
  ]
}

/** Motion scene: up to 4 points revealed one by one under the headline (the caller places the headline). */
export function motionItems(points: string[], f: SceneFrame): Placed[] {
  const st = styles(f)
  const pts = points.slice(0, 4)
  const out = ambience(f)
  if (!pts.length) return out
  const vertical = f.height > f.width
  const rowH = (vertical ? 120 : 92) * st.s
  const top = -((pts.length - 1) * rowH) / 2 + 80 * st.s
  const times = revealTimes(pts, f)
  const textW = f.width * (vertical ? 0.7 : 0.56)
  const markerX = -textW / 2 - 40 * st.s
  pts.forEach((p, i) => {
    const y = top + i * rowH
    out.push(box(f, times[i], { name: `Point ${i + 1} marker`, shape: 'ellipse', x: markerX, y, w: 22 * st.s, h: 22 * st.s, fill: f.pal.accent, anim: pop(0.35) }))
    out.push(label(f, times[i], { text: p, x: 0, y, style: st.ink(vertical ? 46 : 50, textW, { align: 'left' }), anim: { in: { preset: 'slideRight', duration: 0.45 }, out: out_ } }))
  })
  return out
}

/** Diagram scene: shapes and labels laid out for the canvas (the caller places the headline above). */
export function diagramItems(d: SceneDiagram, f: SceneFrame): Placed[] {
  const st = styles(f)
  const { s } = st
  const { pal } = f
  const W = f.width
  const H = f.height
  const vertical = H > W
  const cy = 50 * s // content centre, under the headline band
  const out: Placed[] = []
  const ring = { color: pal.accent, width: Math.max(3, Math.round(4 * s)) }
  switch (d.type) {
    case 'steps': {
      const n = d.items.length
      const times = revealTimes(d.items, f)
      if (vertical) {
        const gap = 50 * s
        const bh = Math.min(150 * s, (H * 0.62) / n - gap)
        const total = n * bh + (n - 1) * gap
        d.items.forEach((t, i) => {
          const y = cy - total / 2 + bh / 2 + i * (bh + gap)
          out.push(box(f, times[i], { name: `Step ${i + 1}`, x: 0, y, w: W * 0.78, h: bh, fill: pal.accent, radius: 24 * s }))
          out.push(label(f, times[i] + 0.1, { text: `${i + 1}. ${t}`, x: 0, y, style: st.node(52, W * 0.7) }))
          if (i < n - 1) out.push(label(f, times[i + 1] - 0.05, { text: '↓', x: 0, y: y + bh / 2 + gap / 2, style: st.accent(48, 100 * s, { uppercase: false, letterSpacing: 0 }), anim: fadeIn(0.3) }))
        })
      } else {
        const gap = 90 * s
        const bw = Math.min(380 * s, (W * 0.88 - (n - 1) * gap) / n)
        const bh = 210 * s
        const total = n * bw + (n - 1) * gap
        d.items.forEach((t, i) => {
          const x = -total / 2 + bw / 2 + i * (bw + gap)
          out.push(box(f, times[i], { name: `Step ${i + 1}`, x, y: cy, w: bw, h: bh, fill: pal.accent, radius: 24 * s }))
          out.push(label(f, times[i] + 0.1, { text: t, x, y: cy, style: st.node(n > 4 ? 40 : 46, bw - 36 * s) }))
          out.push(label(f, times[i] + 0.1, { text: String(i + 1).padStart(2, '0'), x, y: cy - bh / 2 - 40 * s, style: st.accent(28, 120 * s), anim: fadeIn(0.4) }))
          if (i < n - 1) out.push(label(f, times[i + 1] - 0.05, { text: '→', x: x + bw / 2 + gap / 2, y: cy, style: st.accent(64, gap, { uppercase: false, letterSpacing: 0 }), anim: fadeIn(0.3) }))
        })
      }
      break
    }
    case 'cycle': {
      const n = d.items.length
      const R = Math.min(W, H) * (vertical ? 0.3 : 0.27)
      const times = revealTimes(d.items, f)
      out.push(box(f, f.start + 0.4, { name: 'Cycle ring', shape: 'ellipse', x: 0, y: cy, w: R * 2, h: R * 2, fill: 'transparent', stroke: ring, anim: { in: { preset: 'zoomIn', duration: 0.6 }, out: out_ } }))
      const pw = Math.min(330 * s, (2 * Math.PI * R) / n - 30 * s)
      d.items.forEach((t, i) => {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / n
        const x = Math.cos(a) * R
        const y = cy + Math.sin(a) * R
        out.push(box(f, times[i], { name: `Stage ${i + 1}`, x, y, w: pw, h: 110 * s, fill: pal.accent, radius: 55 * s }))
        out.push(label(f, times[i] + 0.1, { text: t, x, y, style: st.node(n > 4 ? 34 : 40, pw - 30 * s) }))
      })
      break
    }
    case 'hub': {
      const n = d.items.length
      const R = Math.min(W, H) * (vertical ? 0.32 : 0.3)
      const times = revealTimes(d.items, f)
      const cw = 320 * s
      const pw = Math.min(330 * s, R * 1.1)
      d.items.forEach((t, i) => {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / n
        const x = Math.cos(a) * R
        const y = cy + Math.sin(a) * R
        out.push(line(f, times[i] - 0.1, { name: `Link ${i + 1}`, x1: (Math.cos(a) * cw) / 2, y1: cy + (Math.sin(a) * cw) / 2, x2: x, y2: y, color: pal.accent, thick: 4 * s }))
        out.push(box(f, times[i], { name: `Part ${i + 1}`, x, y, w: pw, h: 110 * s, fill: pal.canvas, radius: 55 * s, stroke: ring }))
        out.push(label(f, times[i] + 0.1, { text: t, x, y, style: st.ink(38, pw - 30 * s) }))
      })
      out.push(box(f, f.start + 0.5, { name: 'Centre', shape: 'ellipse', x: 0, y: cy, w: cw, h: cw, fill: pal.accent }))
      out.push(label(f, f.start + 0.6, { text: d.center, x: 0, y: cy, style: st.node(46, cw - 50 * s) }))
      break
    }
    case 'bars': {
      const n = d.items.length
      const chartW = W * (vertical ? 0.84 : 0.7)
      const chartH = H * (vertical ? 0.44 : 0.46)
      const base = cy + chartH / 2
      const max = Math.max(...d.items.map((b) => Math.max(0, b.value)), 1e-9)
      const slot = chartW / n
      const bw = Math.min(170 * s, slot * 0.62)
      const times = revealTimes(
        d.items.map((b) => b.label),
        f,
      )
      out.push(line(f, f.start + 0.4, { name: 'Baseline', x1: -chartW / 2, y1: base, x2: chartW / 2, y2: base, color: pal.ink, thick: 3 * s, anim: wipe(0.5) }))
      const unit = d.unit ?? ''
      const fmt = (v: number) => `${unit === '$' ? '$' : ''}${Number.isInteger(v) ? v : round(v, 1)}${unit && unit !== '$' ? (unit.length > 2 ? ` ${unit}` : unit) : ''}`
      d.items.forEach((b, i) => {
        const x = -chartW / 2 + slot / 2 + i * slot
        const h = Math.max(6 * s, (Math.max(0, b.value) / max) * chartH)
        out.push(box(f, times[i], { name: `Bar ${b.label}`, x, y: base - h / 2, w: bw, h, fill: pal.accent, radius: 10 * s, anim: rise(0.6) }))
        out.push(label(f, times[i] + 0.25, { text: fmt(b.value), x, y: base - h - 40 * s, style: st.ink(44, slot, { fontWeight: 800 }), anim: fadeIn(0.4) }))
        out.push(label(f, times[i], { text: b.label, x, y: base + 46 * s, style: st.ink(30, slot - 10 * s, { fontWeight: 500 }), anim: fadeIn(0.4) }))
      })
      break
    }
    case 'compare': {
      const colW = W * (vertical ? 0.8 : 0.38)
      const all = [d.left.title, ...d.left.points, d.right.title, ...d.right.points]
      const times = revealTimes(all, f)
      let k = 0
      if (!vertical) out.push(line(f, f.start + 0.4, { name: 'Divider', x1: 0, y1: cy - H * 0.26, x2: 0, y2: cy + H * 0.28, color: pal.accent, thick: 3 * s, anim: fadeIn(0.5) }))
      for (const [side, c] of [
        [-1, d.left],
        [1, d.right],
      ] as const) {
        const x = vertical ? 0 : side * W * 0.23
        const top = vertical ? (side < 0 ? cy - H * 0.3 : cy + H * 0.04) : cy - H * 0.22
        out.push(label(f, times[k++], { text: c.title, x, y: top, style: st.accent(vertical ? 40 : 44, colW) }))
        c.points.forEach((p, i) => {
          out.push(label(f, times[k++], { text: p, x, y: top + (vertical ? 80 : 110) * s + i * (vertical ? 76 : 96) * s, style: st.ink(vertical ? 38 : 42, colW) }))
        })
      }
      break
    }
    case 'timeline': {
      const n = d.items.length
      const times = revealTimes(
        d.items.map((t) => t.label),
        f,
      )
      if (vertical) {
        const span = H * 0.56
        const x0 = -W * 0.3
        out.push(line(f, f.start + 0.4, { name: 'Timeline', x1: x0, y1: cy - span / 2, x2: x0, y2: cy + span / 2, color: pal.accent, thick: 4 * s, anim: fadeIn(0.5) }))
        d.items.forEach((it, i) => {
          const y = cy - span / 2 + (span * i) / Math.max(1, n - 1)
          out.push(box(f, times[i], { name: `Point ${i + 1}`, shape: 'ellipse', x: x0, y, w: 40 * s, h: 40 * s, fill: pal.accent }))
          out.push(label(f, times[i] + 0.1, { text: it.label, x: x0 + W * 0.33, y: y - (it.detail ? 22 * s : 0), style: st.accent(34, W * 0.56, { align: 'left' }) }))
          if (it.detail) out.push(label(f, times[i] + 0.2, { text: it.detail, x: x0 + W * 0.33, y: y + 28 * s, style: st.ink(30, W * 0.56, { align: 'left', fontWeight: 500 }), anim: fadeIn(0.4) }))
        })
      } else {
        const span = W * 0.8
        out.push(line(f, f.start + 0.4, { name: 'Timeline', x1: -span / 2, y1: cy, x2: span / 2, y2: cy, color: pal.accent, thick: 4 * s, anim: wipe(0.6) }))
        const slot = span / Math.max(1, n - 1)
        d.items.forEach((it, i) => {
          const x = -span / 2 + slot * i
          const up = i % 2 === 0
          out.push(box(f, times[i], { name: `Point ${i + 1}`, shape: 'ellipse', x, y: cy, w: 44 * s, h: 44 * s, fill: pal.accent }))
          out.push(label(f, times[i] + 0.1, { text: it.label, x, y: cy + (up ? -80 : 80) * s, style: st.accent(32, Math.min(slot, 360 * s)) }))
          if (it.detail) out.push(label(f, times[i] + 0.2, { text: it.detail, x, y: cy + (up ? -140 : 140) * s, style: st.ink(28, Math.min(slot, 360 * s), { fontWeight: 500 }), anim: fadeIn(0.4) }))
        })
      }
      break
    }
    case 'stat': {
      const [at] = revealTimes([d.value], f)
      out.push(...ambience(f))
      out.push(label(f, at, { text: d.value, x: 0, y: cy - 30 * s, style: headlineStyle(pal, W, Math.round((vertical ? 220 : 260) * s), { color: pal.accent, lineHeight: 1 }), anim: { in: { preset: 'zoomIn', duration: 0.6 }, out: out_ } }))
      if (d.label) out.push(label(f, at + 0.4, { text: d.label, x: 0, y: cy + (vertical ? 140 : 150) * s, style: st.ink(vertical ? 44 : 48, W * 0.7), anim: fadeIn(0.5) }))
      break
    }
  }
  return out
}

/**
 * Put placed elements on tracks: elements that are on screen at the same time can't share a track, so each scene
 * fills slots 1..n of a stack of tracks that every scene reuses (shapes below text).
 */
export function slotIndex(placed: Placed[]): Map<Placed, number> {
  const slots = new Map<Placed, number>()
  for (const layer of ['shape', 'text'] as const) {
    const ends: number[] = []
    for (const p of placed.filter((x) => x.layer === layer).sort((a, b) => a.item.start - b.item.start)) {
      let k = ends.findIndex((e) => e <= p.item.start + 1e-6)
      if (k < 0) k = ends.length
      ends[k] = p.item.start + p.item.duration
      slots.set(p, k)
    }
  }
  return slots
}
