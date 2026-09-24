// Frame evaluation: project + time -> positioned layers and audio levels. Renderer-agnostic and deterministic
// (no clocks, seeded noise), so the browser preview and the HyperFrames export produce identical frames.
import { FILTERS } from './presets'
import { itemEnd } from './ops'
import type {
  AnimationSpec,
  AudioItem,
  CaptionItem,
  ColorAdjust,
  FrameAudio,
  FrameLayer,
  FrameState,
  Item,
  Project,
  TextItem,
  Track,
  Transition,
  VideoItem,
  VisualItem,
} from './types'
import { clamp, ease, escapeHtml, hash01, sampleKeyframes } from './util'

interface Mods {
  tx: number
  ty: number
  scale: number
  rotate: number
  opacity: number
  blur: number
  brightness: number
  clip?: string
  textReveal?: number
}

const baseMods = (): Mods => ({ tx: 0, ty: 0, scale: 1, rotate: 0, opacity: 1, blur: 0, brightness: 1 })

function backOut(x: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2
}

/** Apply an in/out animation. `p` = 0 (hidden) .. 1 (fully shown). `dir` = 1 for in, -1 for out. */
function applyAnimation(m: Mods, spec: AnimationSpec, p: number, dir: 1 | -1, W: number, H: number) {
  const u = Math.min(W, H) / 1080 // pixel constants are authored for a 1080p canvas
  const e = dir === 1 ? ease('easeOut', p) : ease('easeOut', p)
  const hidden = 1 - e
  switch (spec.preset) {
    case 'fade':
      m.opacity *= e
      break
    case 'slideLeft':
      m.tx += hidden * W * 0.3 * dir
      m.opacity *= Math.min(1, e * 1.5)
      break
    case 'slideRight':
      m.tx -= hidden * W * 0.3 * dir
      m.opacity *= Math.min(1, e * 1.5)
      break
    case 'slideUp':
      m.ty += hidden * H * 0.25 * dir
      m.opacity *= Math.min(1, e * 1.5)
      break
    case 'slideDown':
      m.ty -= hidden * H * 0.25 * dir
      m.opacity *= Math.min(1, e * 1.5)
      break
    case 'rise':
      m.ty += hidden * 60 * u * dir
      m.opacity *= e
      break
    case 'zoomIn':
      m.scale *= dir === 1 ? 0.6 + 0.4 * e : 1 + 0.4 * hidden
      m.opacity *= e
      break
    case 'zoomOut':
      m.scale *= dir === 1 ? 1.4 - 0.4 * e : 1 - 0.3 * hidden
      m.opacity *= e
      break
    case 'pop':
      m.scale *= dir === 1 ? Math.max(0, backOut(clamp(p, 0, 1))) : e
      m.opacity *= Math.min(1, p * 3)
      break
    case 'spin':
      m.rotate += hidden * -180 * dir
      m.scale *= 0.5 + 0.5 * e
      m.opacity *= e
      break
    case 'blur':
      m.blur += hidden * 24 * u
      m.opacity *= e
      break
    case 'wipeLeft':
      m.clip = `inset(0 0 0 ${(hidden * 100).toFixed(2)}%)`
      break
    case 'wipeRight':
      m.clip = `inset(0 ${(hidden * 100).toFixed(2)}% 0 0)`
      break
    case 'typewriter':
      m.textReveal = dir === 1 ? p : 1
      if (dir === -1) m.opacity *= e
      break
    default:
      break
  }
}

function applyTransition(m: Mods, tr: Transition, p: number, side: 'out' | 'in', W: number, H: number) {
  const u = Math.min(W, H) / 1080
  const q = ease('easeInOut', p)
  const o = side === 'out'
  switch (tr.type) {
    case 'crossfade':
      if (!o) m.opacity *= q
      break
    case 'dipBlack':
      if (o) {
        m.brightness *= clamp(1 - 2 * q, 0, 1)
        if (q > 0.5) m.opacity = 0
      } else {
        m.brightness *= clamp(2 * q - 1, 0, 1)
        if (q < 0.5) m.opacity = 0
      }
      break
    case 'dipWhite':
      if (o) {
        m.brightness *= 1 + 4 * q
        if (q > 0.5) m.opacity = 0
      } else {
        m.brightness *= 1 + 4 * (1 - q)
        if (q < 0.5) m.opacity = 0
      }
      break
    case 'slideLeft':
      m.tx += o ? -q * W : (1 - q) * W
      break
    case 'slideRight':
      m.tx += o ? q * W : -(1 - q) * W
      break
    case 'slideUp':
      m.ty += o ? -q * H : (1 - q) * H
      break
    case 'slideDown':
      m.ty += o ? q * H : -(1 - q) * H
      break
    case 'zoomIn':
      if (o) {
        m.scale *= 1 + 0.6 * q
        m.opacity *= 1 - q
      } else {
        m.scale *= 0.8 + 0.2 * q
        m.opacity *= q
      }
      break
    case 'zoomOut':
      if (o) {
        m.scale *= 1 - 0.3 * q
        m.opacity *= 1 - q
      } else {
        m.scale *= 1.3 - 0.3 * q
        m.opacity *= q
      }
      break
    case 'wipeLeft':
      if (!o) m.clip = `inset(0 0 0 ${((1 - q) * 100).toFixed(2)}%)`
      break
    case 'wipeRight':
      if (!o) m.clip = `inset(0 ${((1 - q) * 100).toFixed(2)}% 0 0)`
      break
    case 'blur':
      if (o) {
        m.blur += q * 24 * u
        m.opacity *= 1 - q
      } else {
        m.blur += (1 - q) * 24 * u
        m.opacity *= q
      }
      break
    case 'spin':
      if (o) {
        m.rotate += q * 90
        m.scale *= 1 - 0.5 * q
        m.opacity *= 1 - q
      } else {
        m.rotate -= (1 - q) * 90
        m.scale *= 0.5 + 0.5 * q
        m.opacity *= q
      }
      break
  }
}

export function adjustToFilter(adjust: ColorAdjust | undefined, filterId?: string, intensity = 100): { filter: string; vignette: number } {
  const a: ColorAdjust = { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, tint: 0, hue: 0, sharpen: 0, vignette: 0, ...(adjust ?? {}) }
  let sepia = 0
  let gray = 0
  if (filterId) {
    const f = FILTERS.find((x) => x.id === filterId)
    if (f) {
      const k = intensity / 100
      for (const [key, v] of Object.entries(f.adjust)) a[key as keyof ColorAdjust] += (v as number) * k
      sepia += (f.sepia ?? 0) * k
      gray += (f.grayscale ?? 0) * k
    }
  }
  const parts: string[] = []
  const bright = (1 + a.brightness / 200) * 2 ** (a.exposure / 100)
  if (Math.abs(bright - 1) > 0.001) parts.push(`brightness(${bright.toFixed(3)})`)
  const contrast = 1 + a.contrast / 100 + a.sharpen / 400
  if (Math.abs(contrast - 1) > 0.001) parts.push(`contrast(${contrast.toFixed(3)})`)
  const sat = 1 + a.saturation / 100
  if (Math.abs(sat - 1) > 0.001) parts.push(`saturate(${Math.max(0, sat).toFixed(3)})`)
  if (a.temperature > 0) sepia += a.temperature * 0.35
  const hue = a.hue * 1.8 + (a.temperature < 0 ? a.temperature * 0.25 : 0) + a.tint * 0.4
  if (sepia > 0) parts.push(`sepia(${clamp(sepia / 100, 0, 1).toFixed(3)})`)
  if (gray > 0) parts.push(`grayscale(${clamp(gray / 100, 0, 1).toFixed(3)})`)
  if (Math.abs(hue) > 0.01) parts.push(`hue-rotate(${hue.toFixed(2)}deg)`)
  return { filter: parts.join(' '), vignette: a.vignette }
}

function naturalSize(p: Project, it: VisualItem): { w: number; h: number } {
  if (it.type === 'video' || it.type === 'image') {
    const a = p.assets[it.assetId]
    let w = a?.width || p.width
    let h = a?.height || p.height
    if (it.crop) {
      w *= Math.max(0.01, 1 - it.crop.left - it.crop.right)
      h *= Math.max(0.01, 1 - it.crop.top - it.crop.bottom)
    }
    return { w, h }
  }
  if (it.type === 'shape') return { w: it.width, h: it.height }
  return { w: it.style.boxWidth, h: 0 }
}

function sourceTime(p: Project, it: VideoItem, local: number): number {
  const asset = p.assets[it.assetId]
  const dur = asset?.duration ?? Infinity
  if (it.freezeAt !== undefined) return it.freezeAt
  const span = it.duration * it.speed
  const offset = it.reverse ? span - local * it.speed : local * it.speed
  return clamp(it.in + offset, 0, Math.max(0, dur - 0.001))
}

function textHtml(it: TextItem, reveal?: number): string {
  let text = it.style.uppercase ? it.text.toUpperCase() : it.text
  if (reveal !== undefined && reveal < 1) text = text.slice(0, Math.floor(text.length * clamp(reveal, 0, 1)))
  return escapeHtml(text).replace(/\n/g, '<br>')
}

function captionHtml(c: CaptionItem, local: number, mode: 'line' | 'word' | 'karaoke', highlight: string, upper: boolean): string {
  const fmt = (s: string) => escapeHtml(upper ? s.toUpperCase() : s)
  if (!c.words?.length || mode === 'line') return fmt(c.text)
  if (mode === 'word') {
    const cur = [...c.words].reverse().find((w) => local >= w.start) ?? c.words[0]
    return fmt(cur.w)
  }
  return c.words
    .map((w) => (local >= w.start && local < w.end + 0.05 ? `<span style="color:${highlight}">${fmt(w.w)}</span>` : fmt(w.w)))
    .join(' ')
}

interface Active {
  item: Item
  local: number
  transition?: { tr: Transition; p: number; side: 'out' | 'in' }
}

/** Items visible at t on a track, including transition overlap (outgoing item held, incoming pre-rolled). */
function activeOnTrack(track: Track, t: number): Active[] {
  const out: Active[] = []
  const items = track.items
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const end = itemEnd(it)
    if (t >= it.start && t < end) out.push({ item: it, local: t - it.start })
  }
  // transitions between adjacent items
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i]
    const b = items[i + 1]
    const tr = 'transitionOut' in a ? a.transitionOut : undefined
    if (!tr || tr.duration <= 0) continue
    const cut = itemEnd(a)
    if (Math.abs(b.start - cut) > 0.05) continue
    const half = Math.min(tr.duration / 2, a.duration / 2, b.duration / 2)
    if (t < cut - half || t >= cut + half) continue
    const p = (t - (cut - half)) / (2 * half)
    const ia = out.find((x) => x.item.id === a.id)
    const ib = out.find((x) => x.item.id === b.id)
    if (ia) ia.transition = { tr, p, side: 'out' }
    else out.push({ item: a, local: t - a.start, transition: { tr, p, side: 'out' } })
    if (ib) ib.transition = { tr, p, side: 'in' }
    else out.push({ item: b, local: t - b.start, transition: { tr, p, side: 'in' } })
  }
  // outgoing below incoming
  out.sort((x, y) => x.item.start - y.item.start)
  return out
}

function visualLayer(p: Project, track: Track, a: Active, z: number, t: number): FrameLayer | null {
  const it = a.item as VisualItem
  const W = p.width
  const H = p.height
  const lt = a.local
  const u = Math.min(W, H) / 1080
  const m = baseMods()
  const kf = it.keyframes ?? {}
  const x = sampleKeyframes(kf.x, lt, it.transform.x)
  const y = sampleKeyframes(kf.y, lt, it.transform.y)
  const scale = sampleKeyframes(kf.scale, lt, it.transform.scale)
  const rotation = sampleKeyframes(kf.rotation, lt, it.transform.rotation)
  const opacity = sampleKeyframes(kf.opacity, lt, it.opacity)

  const anim = it.animations ?? {}
  if (anim.in && anim.in.preset !== 'none' && lt < anim.in.duration) applyAnimation(m, anim.in, lt / anim.in.duration, 1, W, H)
  const rem = it.duration - lt
  if (anim.out && anim.out.preset !== 'none' && rem < anim.out.duration) applyAnimation(m, anim.out, Math.max(0, rem) / anim.out.duration, -1, W, H)
  if (anim.combo && anim.combo.preset !== 'none') {
    const ph = (2 * Math.PI * lt) / Math.max(0.2, anim.combo.period)
    if (anim.combo.preset === 'pulse') m.scale *= 1 + 0.04 * Math.sin(ph)
    if (anim.combo.preset === 'float') m.ty += 12 * u * Math.sin(ph)
    if (anim.combo.preset === 'swing') m.rotate += 6 * Math.sin(ph)
    if (anim.combo.preset === 'shake') m.tx += 6 * u * Math.sin(ph * 3)
  }
  if (a.transition) applyTransition(m, a.transition.tr, a.transition.p, a.transition.side, W, H)

  // effects
  let extraFilter = ''
  const overlays: string[] = []
  const frame = Math.floor(t * p.fps)
  for (const fx of it.effects ?? []) {
    const k = fx.intensity / 100
    switch (fx.type) {
      case 'blur':
        m.blur += 20 * k * u
        break
      case 'blackWhite':
        extraFilter += ` grayscale(${k.toFixed(2)})`
        break
      case 'glow':
        extraFilter += ` drop-shadow(0 0 ${(24 * k * u).toFixed(1)}px rgba(255,255,255,${(0.6 * k).toFixed(2)}))`
        break
      case 'flash': {
        const beat = (lt * 2) % 1
        m.brightness *= 1 + 1.5 * k * Math.max(0, 1 - beat * 4)
        break
      }
      case 'shake':
        m.tx += (hash01(frame * 1.7 + 3) - 0.5) * 30 * k * u
        m.ty += (hash01(frame * 2.3 + 9) - 0.5) * 30 * k * u
        m.rotate += (hash01(frame * 3.1 + 5) - 0.5) * 2 * k
        break
      case 'zoomPulse':
        m.scale *= 1 + 0.08 * k * (0.5 + 0.5 * Math.sin(lt * Math.PI * 2))
        break
      case 'kenBurns':
        m.scale *= 1 + 0.15 * k * clamp(lt / Math.max(0.1, it.duration), 0, 1)
        m.tx += -40 * k * u * clamp(lt / Math.max(0.1, it.duration), 0, 1)
        break
      case 'rgbSplit': {
        const d = (6 * k * u).toFixed(1)
        extraFilter += ` drop-shadow(${d}px 0 0 rgba(255,0,60,.55)) drop-shadow(-${d}px 0 0 rgba(0,220,255,.55))`
        break
      }
      case 'vhs':
        extraFilter += ` saturate(${(1 + 0.3 * k).toFixed(2)}) contrast(${(1 + 0.1 * k).toFixed(2)})`
        overlays.push(`repeating-linear-gradient(0deg, rgba(0,0,0,${(0.18 * k).toFixed(2)}) 0 ${(2 * u).toFixed(2)}px, transparent ${(2 * u).toFixed(2)}px ${(4 * u).toFixed(2)}px)`)
        m.tx += (hash01(frame * 0.37) > 0.92 ? (hash01(frame) - 0.5) * 20 * k * u : 0)
        break
      case 'grain': {
        const seed = frame % 97
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' seed='${seed}'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='${(0.35 * k).toFixed(2)}'/></svg>`
        overlays.push(`url("data:image/svg+xml;utf8,${svg.replace(/"/g, "'").replace(/#/g, '%23')}")`)
        break
      }
      case 'vignette':
        overlays.push(`radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,${(0.75 * k).toFixed(2)}) 100%)`)
        break
    }
  }

  let filter = ''
  if (it.type === 'video' || it.type === 'image') {
    const f = adjustToFilter(it.adjust, it.filter?.id, it.filter?.intensity ?? 100)
    filter = f.filter
    if (f.vignette > 0) overlays.push(`radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${(f.vignette / 100).toFixed(2)}) 100%)`)
  }
  if (m.brightness !== 1) filter += ` brightness(${m.brightness.toFixed(3)})`
  if (m.blur > 0.01) filter += ` blur(${m.blur.toFixed(2)}px)`
  filter = (filter + extraFilter).trim()

  const nat = naturalSize(p, it)
  let bw = nat.w
  let bh = nat.h
  if (it.type === 'video' || it.type === 'image') {
    const s = it.fit === 'cover' ? Math.max(W / nat.w, H / nat.h) : Math.min(W / nat.w, H / nat.h)
    bw = nat.w * s
    bh = nat.h * s
  }
  const flipX = it.transform.flipX ? -1 : 1
  const flipY = it.transform.flipY ? -1 : 1
  const sc = scale * m.scale
  const transform = `rotate(${(rotation + m.rotate).toFixed(3)}deg) scale(${(sc * flipX).toFixed(4)}, ${(sc * flipY).toFixed(4)})`
  const layer: FrameLayer = {
    itemId: it.id,
    trackId: track.id,
    type: it.type,
    box: { cx: W / 2 + x + m.tx, cy: H / 2 + y + m.ty, width: bw, height: bh },
    transform,
    opacity: clamp(opacity * m.opacity, 0, 1),
    filter,
    blend: it.blend ?? 'normal',
    clipPath: m.clip,
    overlay: overlays.length ? overlays.join(', ') : undefined,
    z,
  }
  if (it.type === 'video') {
    layer.assetId = it.assetId
    layer.mediaTime = sourceTime(p, it, lt)
    layer.objectFit = 'fill'
    layer.crop = it.crop
    layer.background = track.main ? it.background : undefined
  } else if (it.type === 'image') {
    layer.assetId = it.assetId
    layer.objectFit = 'fill'
    layer.crop = it.crop
    layer.background = track.main ? it.background : undefined
  } else if (it.type === 'text') {
    layer.text = { html: textHtml(it, m.textReveal), style: it.style }
  } else if (it.type === 'shape') {
    layer.shape = it
  }
  return layer
}

function audioLevel(it: AudioItem | VideoItem, lt: number): number {
  let v = sampleKeyframes(it.keyframes?.volume, lt, it.volume)
  if (it.fadeIn > 0 && lt < it.fadeIn) v *= lt / it.fadeIn
  const rem = it.duration - lt
  if (it.fadeOut > 0 && rem < it.fadeOut) v *= Math.max(0, rem) / it.fadeOut
  return clamp(v, 0, 4)
}

export function evaluate(p: Project, t: number): FrameState {
  const layers: FrameLayer[] = []
  const audio: FrameAudio[] = []
  let z = 0
  const visual = p.tracks.filter((tr) => tr.kind !== 'audio' && tr.kind !== 'caption')
  const captions = p.tracks.filter((tr) => tr.kind === 'caption')
  for (const track of visual) {
    for (const a of activeOnTrack(track, t)) {
      const it = a.item
      if (!track.hidden && (it.type === 'video' || it.type === 'image' || it.type === 'text' || it.type === 'shape')) {
        const l = visualLayer(p, track, a, z++, t)
        if (l && l.opacity > 0.001) layers.push(l)
      }
      if (it.type === 'video' && !it.muted && !track.muted && it.freezeAt === undefined) {
        if (t >= it.start && t < itemEnd(it)) {
          const asset = p.assets[it.assetId]
          if (asset?.hasAudio !== false) audio.push({ itemId: it.id, assetId: it.assetId, mediaTime: sourceTime(p, it, a.local), volume: audioLevel(it, a.local), speed: it.speed })
        }
      }
    }
  }
  for (const track of p.tracks.filter((tr) => tr.kind === 'audio')) {
    if (track.muted) continue
    for (const it of track.items) {
      if (it.type !== 'audio' || it.muted || t < it.start || t >= itemEnd(it)) continue
      const lt = t - it.start
      audio.push({ itemId: it.id, assetId: it.assetId, mediaTime: it.in + lt * it.speed, volume: audioLevel(it, lt), speed: it.speed })
    }
  }
  for (const track of captions) {
    if (track.hidden || !track.captionStyle) continue
    const cs = track.captionStyle
    for (const it of track.items) {
      if (it.type !== 'caption' || t < it.start || t >= itemEnd(it)) continue
      const lt = t - it.start
      layers.push({
        itemId: it.id,
        trackId: track.id,
        type: 'caption',
        box: { cx: p.width / 2, cy: p.height * cs.position, width: Math.min(cs.style.boxWidth, p.width * 0.92), height: 0 },
        transform: 'rotate(0deg) scale(1, 1)',
        opacity: 1,
        filter: '',
        blend: 'normal',
        text: { html: captionHtml(it, lt, cs.mode, cs.highlightColor, cs.style.uppercase), style: { ...cs.style, uppercase: false } },
        z: 100000 + z++,
      })
    }
  }
  return { time: t, layers, audio }
}

/** CSS declarations for a text box (shared by preview and export renderers). */
export function textCss(style: TextItem['style']): string {
  const s = style
  const shadows: string[] = []
  if (s.shadow) shadows.push(`${s.shadow.x}px ${s.shadow.y}px ${s.shadow.blur}px ${s.shadow.color}`)
  if (s.glow) shadows.push(`0 0 ${s.glow.blur}px ${s.glow.color}`, `0 0 ${s.glow.blur * 2}px ${s.glow.color}`)
  const css = [
    `font-family:'${s.fontFamily}', Inter, system-ui, sans-serif`,
    `font-size:${s.fontSize}px`,
    `font-weight:${s.fontWeight}`,
    `font-style:${s.italic ? 'italic' : 'normal'}`,
    `text-decoration:${s.underline ? 'underline' : 'none'}`,
    `text-align:${s.align}`,
    `letter-spacing:${s.letterSpacing}px`,
    `line-height:${s.lineHeight}`,
    `color:${s.color}`,
    `white-space:pre-wrap`,
    `overflow-wrap:break-word`,
  ]
  if (s.stroke && s.stroke.width > 0) css.push(`-webkit-text-stroke:${s.stroke.width}px ${s.stroke.color}`, `paint-order:stroke fill`)
  if (shadows.length) css.push(`text-shadow:${shadows.join(', ')}`)
  return css.join(';')
}

/** CSS for the inline background "pill" behind text lines. */
export function textBackgroundCss(style: TextItem['style']): string {
  const b = style.background
  if (!b) return ''
  const hex = b.color.replace('#', '')
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const bl = parseInt(full.slice(4, 6), 16)
  return `background:rgba(${r},${g},${bl},${b.opacity});border-radius:${b.radius}px;padding:${b.padding * 0.5}px ${b.padding}px;box-decoration-break:clone;-webkit-box-decoration-break:clone`
}
