// Motion text and diagrams as timeline items: the editor's own shapes and text, laid out for the canvas and revealed as
// the narration names each part. Editable afterwards, on brand (look + brand kit), identical in preview and export.
import { createImageItem, createShapeItem, createTextItem, round, type AnimationStyle, type Asset, type Item, type ItemAnimations, type Keyframe, type Keyframes, type SceneDiagram, type TextStyle } from '@producer/core'
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
  // content centre: under the headline band, and clear of the captions along the bottom (landscape has less room)
  const cy = (vertical ? 50 : 20) * s
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
      const R = Math.min(W, H) * (vertical ? 0.3 : 0.24)
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
      const R = Math.min(W, H) * (vertical ? 0.32 : 0.25)
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
      const chartH = H * (vertical ? 0.44 : 0.4)
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

// ---------------- animation scenes: illustrations that move with the narration ----------------

/** One illustration of an animation scene: its picture (absent: it couldn't be found, so a labelled disc stands in). */
export interface AnimObject {
  name: string
  label?: string
  asset?: Asset
  /** No words on screen: a stand-in for a missing picture is a plain disc. */
  noWord?: boolean
}

const kf = (t: number, value: number, ease: Keyframe['ease'] = 'easeInOut'): Keyframe => ({ t: round(Math.max(0, t), 3), value: round(value, 3), ease })

/** Keyframes that move a caption along with its picture: the same x, and y shifted by `dy`. */
const follow = (keys: Keyframes | undefined, dy: number): Keyframes | undefined =>
  keys && (keys.x || keys.y) ? { ...(keys.x ? { x: keys.x } : {}), ...(keys.y ? { y: keys.y.map((k) => ({ ...k, value: round(k.value + dy, 3) })) } : {}) } : undefined

/**
 * An illustration at (x, y), `size` px across, on screen from `at` to the scene's end. `keys` are keyframes in seconds
 * from `at` (absolute values, as the editor stores them; `scale` in canvas fits like the item's own).
 */
function pic(f: SceneFrame, at: number, o: { obj: AnimObject; x: number; y: number; size: number; keys?: Keyframes; anim?: ItemAnimations; float?: number; name?: string }): Placed[] {
  const name = o.name ?? o.obj.name
  if (!o.obj.asset) {
    // a disc in the accent colour with the name on it: the scene still says what it means
    const st = styles(f)
    const { scale: _scale, ...moves } = o.keys ?? {}
    const disc = box(f, at, { name: `${name} (no picture found)`, shape: 'ellipse', x: o.x, y: o.y, w: o.size * 0.8, h: o.size * 0.8, fill: f.pal.accent, anim: o.anim ?? pop(), float: o.float })
    disc.item = { ...disc.item, keyframes: moves } as Item
    if (o.obj.noWord) return [disc]
    const word = label(f, at + 0.1, { text: o.obj.name.slice(0, 18), x: o.x, y: o.y, style: st.node(o.size > 300 * st.s ? 40 : 28, o.size * 0.7), anim: fadeIn(0.3) })
    word.item = { ...word.item, keyframes: follow(o.keys, 0) ?? {} } as Item
    return [disc, word]
  }
  const fit = o.size / Math.min(f.width, f.height)
  const item = createImageItem(o.obj.asset, 0, {
    ...until(f, at),
    name,
    transform: { x: round(o.x, 1), y: round(o.y, 1), scale: round(fit, 4), rotation: 0 },
    keyframes: o.keys ?? {},
    animations: { ...(o.anim ?? pop(0.5)), ...(o.float ? { combo: { preset: 'float' as const, period: o.float } } : {}) },
  })
  return [{ layer: 'shape', item }]
}

/** The caption under an illustration, when it has one (moving with it when `keys` are given). */
function caption(f: SceneFrame, at: number, obj: AnimObject, x: number, y: number, w: number, keys?: Keyframes): Placed[] {
  if (!obj.label) return []
  const st = styles(f)
  const l = label(f, at + 0.2, { text: obj.label, x, y, style: st.ink(f.height > f.width ? 40 : 38, w), anim: fadeIn(0.4) })
  if (keys) l.item = { ...l.item, keyframes: keys } as Item
  return [l]
}

/** Only on screen until `t` (absolute seconds), for parts that leave before the scene ends. */
function endAt(parts: Placed[], t: number) {
  for (const p of parts) p.item.duration = round(Math.max(0.4, t - p.item.start), 3)
  return parts
}

/**
 * Animation scene: illustrations (open-source emoji art, found for each object's name) moving in one of six ways,
 * each part arriving as the narration names it. The caller places the headline above, as for a diagram.
 */
export function animationItems(style: AnimationStyle, objects: AnimObject[], f: SceneFrame): Placed[] {
  const objs = objects.slice(0, style === 'row' || style === 'grow' ? 4 : 5)
  const out = ambience(f)
  if (!objs.length) return out
  const { s } = styles(f)
  const W = f.width
  const H = f.height
  const vertical = H > W
  // content centre: under the headline band, clear of the captions along the bottom
  const cy = (vertical ? 60 : 40) * s
  const times = revealTimes(
    objs.map((o) => [o.label, o.name].filter(Boolean).join(' ')),
    f,
  )
  const end = f.start + f.duration
  switch (style) {
    case 'row':
    case 'grow': {
      const n = objs.length
      const grow = style === 'grow'
      // landscape: side by side; vertical: stacked when there are more than two
      const stack = vertical && n > 2
      const span = stack ? H * 0.56 : W * (n === 1 ? 0.3 : 0.78)
      const slot = span / n
      const base = Math.min(slot * (stack ? 0.8 : 0.78), stack ? H * 0.17 : H * 0.42)
      const floor = cy + base / 2
      objs.forEach((o, i) => {
        const size = base * (grow ? 0.55 + (0.45 * (i + 1)) / n : 1)
        const at = times[i]
        if (stack) {
          const y = cy - span / 2 + slot * (i + 0.5)
          out.push(...pic(f, at, { obj: o, x: -W * 0.16, y, size, float: 5 + i }))
          out.push(...caption(f, at, o, W * 0.2, y, W * 0.4))
          return
        }
        const x = -span / 2 + slot * (i + 0.5)
        // grow: they stand on one line, so the bigger ones reach higher
        const y = grow ? floor - size / 2 : cy - 20 * s
        out.push(...pic(f, at, { obj: o, x, y, size, anim: grow ? rise(0.6) : pop(0.5), float: grow ? undefined : 5 + i }))
        out.push(...caption(f, at, o, x, (grow ? floor : y + size / 2) + 46 * s, slot * 0.95))
      })
      if (grow && !stack) out.push(line(f, f.start + 0.4, { name: 'Ground', x1: -span / 2, y1: floor + 6 * s, x2: span / 2, y2: floor + 6 * s, color: f.pal.accent, thick: 4 * s, anim: wipe(0.6) }))
      return out
    }
    case 'journey': {
      // the first travels a line past the rest, reaching each as it's named
      const [mover, ...stops] = objs
      const len = vertical ? H * 0.5 : W * 0.76
      const along = (u: number) => (vertical ? { x: -W * 0.12, y: cy - len / 2 + len * u } : { x: -len / 2 + len * u, y: cy + 80 * s })
      const size = (vertical ? 200 : 220) * s
      const stopSize = (vertical ? 170 : 180) * s
      const a = along(0)
      const b = along(1)
      out.push(line(f, f.start + 0.4, { name: 'Path', x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: f.pal.accent, thick: 4 * s, anim: wipe(0.7) }))
      const startAt = Math.max(f.start + 0.5, times[0] - 0.2)
      const u = (i: number) => (i + 1) / (stops.length + 1)
      const offset = vertical ? { x: 250 * s, y: 0 } : { x: 0, y: -220 * s }
      stops.forEach((o, i) => {
        const p = along(u(i))
        const at = Math.max(startAt + 0.3, times[i + 1] - 0.4)
        // a stop shows up a beat before the traveller gets there
        const sx = p.x + offset.x
        const sy = p.y + offset.y
        out.push(...pic(f, at, { obj: o, x: sx, y: sy, size: stopSize, float: 6 + i }))
        out.push(...caption(f, at, o, sx, vertical ? sy + stopSize / 2 + 34 * s : sy - stopSize / 2 - 34 * s, (vertical ? W * 0.4 : len / (stops.length + 1)) * 0.95))
      })
      const xs: Keyframe[] = [kf(0, a.x)]
      const ys: Keyframe[] = [kf(0, a.y)]
      const rot: Keyframe[] = []
      const arrive = stops.length ? stops.map((_, i) => times[i + 1] + 0.1) : [Math.min(end - 0.8, f.voiceStart + f.voiceDuration)]
      let t0 = 0
      arrive.forEach((at, i) => {
        const p = stops.length ? along(u(i)) : b
        const t = Math.max(t0 + 0.6, at - startAt)
        xs.push(kf(t, p.x))
        ys.push(kf(t, p.y))
        // a little tilt forward while moving, level when it stops
        rot.push(kf(t0, 0), kf(t0 + (t - t0) / 2, vertical ? 4 : -6), kf(t, 0))
        t0 = t
      })
      // past the last stop, on to the end of the path
      if (stops.length) {
        const t = Math.min(end - startAt - 0.3, t0 + 1.6)
        if (t > t0 + 0.4) {
          xs.push(kf(t, b.x))
          ys.push(kf(t, b.y))
        }
      }
      out.push(...pic(f, startAt, { obj: mover, x: a.x, y: a.y, size, keys: { x: xs, y: ys, rotation: rot }, anim: pop(0.5) }))
      out.push(...caption(f, startAt, mover, a.x, a.y + size / 2 + 30 * s, 300 * s, follow({ x: xs, y: ys }, size / 2 + 30 * s)))
      return out
    }
    case 'orbit': {
      // the rest circle the first, slowly
      const [hub, ...moons] = objs
      const hubSize = (vertical ? 300 : 300) * s
      const R = vertical ? Math.min(W * 0.36, 380 * s) : Math.min(H * 0.3, 310 * s)
      const rx = vertical ? R : R * 1.5
      const moonSize = (vertical ? 170 : 170) * s
      out.push(box(f, f.start + 0.4, { name: 'Orbit', shape: 'ellipse', x: 0, y: cy, w: rx * 2, h: R * 2, fill: 'transparent', stroke: { color: f.pal.accent, width: Math.max(2, Math.round(3 * s)) }, opacity: 0.5, anim: { in: { preset: 'zoomIn', duration: 0.6 }, out: out_ } }))
      out.push(...pic(f, times[0], { obj: hub, x: 0, y: cy, size: hubSize, anim: { in: { preset: 'zoomIn', duration: 0.6 }, out: out_ }, float: 7 }))
      out.push(...caption(f, times[0], hub, 0, cy + hubSize / 2 + 30 * s, W * 0.3))
      // one turn in 14 s, sampled every quarter second (linear between samples reads as a smooth circle)
      const period = 14
      moons.forEach((o, i) => {
        const at = times[i + 1]
        const life = end - at
        const phase = (2 * Math.PI * i) / moons.length - Math.PI / 2
        const xs: Keyframe[] = []
        const ys: Keyframe[] = []
        const steps = Math.max(2, Math.ceil(life / 0.25))
        for (let k = 0; k <= steps; k++) {
          const t = (life * k) / steps
          const ang = phase + (2 * Math.PI * (at - f.start + t)) / period
          xs.push(kf(t, Math.cos(ang) * rx, 'linear'))
          ys.push(kf(t, cy + Math.sin(ang) * R, 'linear'))
        }
        out.push(...pic(f, at, { obj: o, x: xs[0].value, y: ys[0].value, size: moonSize, keys: { x: xs, y: ys }, anim: pop(0.45) }))
        out.push(...caption(f, at, o, xs[0].value, ys[0].value + moonSize / 2 + 26 * s, 260 * s, follow({ x: xs, y: ys }, moonSize / 2 + 26 * s)))
      })
      return out
    }
    case 'burst': {
      // copies of the rest fly out of the first: one idea, many results
      const [core, ...rest] = objs
      const coreSize = 300 * s
      const coreParts = pic(f, times[0], { obj: core, x: 0, y: cy, size: coreSize, anim: { in: { preset: 'zoomIn', duration: 0.5 }, out: out_ } })
      out.push(...coreParts)
      out.push(...caption(f, times[0], core, 0, cy + coreSize / 2 + 30 * s, W * 0.3))
      const pulse: Array<[number, number]> = []
      const total = Math.max(1, rest.length) * 3
      const ring = (n: number, i: number, far: number) => {
        const ang = (2 * Math.PI * n) / total - Math.PI / 2 + (i % 2 ? 0.3 : 0)
        const dist = (vertical ? W * 0.34 : H * 0.36) * far
        return { x: Math.cos(ang) * dist * (vertical ? 1 : 1.55), y: cy + Math.sin(ang) * dist }
      }
      rest.forEach((o, i) => {
        const at = Math.max(times[i + 1], times[0] + 0.6)
        pulse.push([at - times[0], 1.12])
        for (let c = 0; c < 3; c++) {
          const p = ring(i * 3 + c, i, c === 1 ? 1.08 : 0.92)
          const size = (vertical ? 130 : 140) * s * (c === 1 ? 1.1 : 0.9)
          const fit = size / Math.min(W, H)
          const d = 0.7 + c * 0.08
          const keys: Keyframes = {
            x: [kf(0, 0, 'easeOut'), kf(d, p.x)],
            y: [kf(0, cy, 'easeOut'), kf(d, p.y)],
            scale: [kf(0, fit * 0.2, 'easeOut'), kf(d, fit)],
            rotation: [kf(0, -90 + c * 60, 'easeOut'), kf(d, 0)],
          }
          out.push(...pic(f, at + c * 0.08, { obj: o, x: 0, y: cy, size, keys, anim: fadeIn(0.15), name: `${o.name} ${c + 1}` }))
        }
        const lp = ring(i * 3 + 1, i, 1.08)
        out.push(...caption(f, at + 0.5, o, lp.x, lp.y + 100 * s, 300 * s))
      })
      // the first gives a little kick each time something leaves it
      const first = coreParts[0].item
      if (first.type === 'image' && pulse.length) {
        const base = first.transform.scale
        first.keyframes = { scale: [kf(0, base), ...pulse.flatMap(([t, k]) => [kf(t - 0.15, base), kf(t, base * k, 'easeOut'), kf(t + 0.3, base)])] }
      }
      return out
    }
    case 'change': {
      // each one turns into the next: before → after
      const size = (vertical ? 360 : 360) * s
      const fit = size / Math.min(W, H)
      const capY = cy + size / 2 + 40 * s
      let at = times[0]
      objs.forEach((o, i) => {
        const next = i < objs.length - 1 ? Math.max(times[i + 1], at + 1.2) : undefined
        const keys: Keyframes | undefined = next
          ? {
              scale: [kf(0, fit), kf(next - at - 0.1, fit * 1.06), kf(next - at + 0.35, fit * 0.02, 'easeIn')],
              rotation: [kf(next - at - 0.1, 0), kf(next - at + 0.35, 200, 'easeIn')],
            }
          : undefined
        const parts = pic(f, at, { obj: o, x: 0, y: cy, size, keys, anim: i === 0 ? pop(0.5) : { in: { preset: 'zoomIn', duration: 0.45 }, out: out_ } })
        const cap = caption(f, at, o, 0, capY, W * 0.5)
        out.push(...(next ? endAt(parts, next + 0.4) : parts), ...(next ? endAt(cap, next) : cap))
        if (next) {
          // a ring flashes out as it changes
          const flash = box(f, next - 0.05, { name: 'Change ring', shape: 'ellipse', x: 0, y: cy, w: size * 1.2, h: size * 1.2, fill: 'transparent', stroke: { color: f.pal.accent, width: Math.max(3, Math.round(5 * s)) }, anim: { in: { preset: 'zoomIn', duration: 0.35 }, out: out_ } })
          out.push(...endAt([flash], next + 0.6))
          at = next + 0.25
        }
      })
      return out
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
