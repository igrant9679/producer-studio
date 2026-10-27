// DOM renderer for evaluated frames. The editor preview uses it in 'preview' mode (it owns <video>/<audio>
// playback); the HyperFrames export bundles it in 'export' mode (media elements are pre-declared in the
// composition and HyperFrames owns their playback, the renderer only positions and styles them).
import { evaluate, textBackgroundCss, textCss } from './evaluate'
import { itemEnd, projectDuration } from './ops'
import type { FrameLayer, Project, VideoItem } from './types'
import { cssNumber, escapeHtml, safeColor } from './util'

export type UrlResolver = (assetId: string, kind: 'media' | 'proxy') => string

export interface RendererOptions {
  mode: 'preview' | 'export'
  resolveUrl: UrlResolver
  /** Preview: called when a media element is waiting for data (for a buffering indicator). */
  onBuffering?: (waiting: boolean) => void
}

interface LayerEl {
  wrap: HTMLDivElement
  content: HTMLElement
  overlay: HTMLDivElement
  bg?: HTMLDivElement
  bgMedia?: HTMLVideoElement | HTMLImageElement
  /** Export: the still shown over the video (and its blurred background) until the file starts. */
  hold?: { until: number; still: HTMLImageElement; bgStill?: HTMLImageElement }
  kind: FrameLayer['type']
  lastText?: string
  lastStyle?: string
}

const LAYER_BASE = 'position:absolute;transform-origin:50% 50%;will-change:transform,opacity;'
const MEDIA_FILL = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill;display:block'

export class StageRenderer {
  readonly root: HTMLElement
  private project: Project
  private opts: RendererOptions
  private layers = new Map<string, LayerEl>()
  private audioEls = new Map<string, HTMLAudioElement>()
  private playing = false
  private rate = 1
  private waiting = new Set<string>()

  constructor(root: HTMLElement, project: Project, opts: RendererOptions) {
    this.root = root
    this.project = project
    this.opts = opts
    root.style.position = 'relative'
    root.style.overflow = 'hidden'
    root.style.background = safeColor(project.background, '#000000')
  }

  setProject(p: Project) {
    this.project = p
    this.root.style.background = safeColor(p.background, '#000000')
    // drop elements for items that no longer exist
    const ids = new Set(p.tracks.flatMap((t) => t.items.map((i) => i.id)))
    for (const [id, el] of this.layers) if (!ids.has(id)) this.removeLayer(id, el)
    for (const [id, el] of this.audioEls)
      if (!ids.has(id)) {
        el.pause()
        el.remove()
        this.audioEls.delete(id)
      }
  }

  get duration() {
    return projectDuration(this.project)
  }

  /** Preview only: mark transport state so media elements play natively between frames. */
  setPlaying(playing: boolean, rate = 1) {
    this.playing = playing
    this.rate = rate
    if (!playing) {
      for (const el of this.layers.values()) if (el.content instanceof HTMLVideoElement) el.content.pause()
      for (const a of this.audioEls.values()) a.pause()
    }
  }

  render(t: number) {
    const frame = evaluate(this.project, t)
    const seen = new Set<string>()
    for (const layer of frame.layers) {
      seen.add(layer.itemId)
      this.drawLayer(layer, t)
    }
    for (const [id, el] of this.layers) {
      if (!seen.has(id)) {
        el.wrap.style.display = 'none'
        if (el.bg) el.bg.style.display = 'none'
        if (this.opts.mode === 'preview' && el.content instanceof HTMLVideoElement && !el.content.paused) el.content.pause()
      }
    }
    if (this.opts.mode === 'preview') this.syncAudio(frame.audio, t)
  }

  destroy() {
    for (const [id, el] of this.layers) this.removeLayer(id, el)
    for (const a of this.audioEls.values()) {
      a.pause()
      a.remove()
    }
    this.audioEls.clear()
  }

  private removeLayer(id: string, el: LayerEl) {
    if (el.content instanceof HTMLVideoElement) {
      el.content.pause()
      if (this.opts.mode === 'preview') el.content.removeAttribute('src')
    }
    if (this.opts.mode === 'preview') {
      el.wrap.remove()
      el.bg?.remove()
    }
    this.layers.delete(id)
  }

  private createLayer(layer: FrameLayer): LayerEl {
    const exportMode = this.opts.mode === 'export'
    let wrap = exportMode ? (this.root.querySelector(`[data-ps-layer="${layer.itemId}"]`) as HTMLDivElement | null) : null
    let content: HTMLElement
    let bg: HTMLDivElement | undefined
    let bgMedia: HTMLVideoElement | HTMLImageElement | undefined
    if (wrap) {
      content = (wrap.querySelector('[data-ps-content]') as HTMLElement) ?? wrap
      bg = (this.root.querySelector(`[data-ps-bg="${layer.itemId}"]`) as HTMLDivElement | null) ?? undefined
      bgMedia = (bg?.querySelector('video,img:not([data-ps-hold])') as HTMLVideoElement | HTMLImageElement | null) ?? undefined
    } else {
      wrap = document.createElement('div')
      wrap.dataset.psLayer = layer.itemId
      if (layer.type === 'video') {
        const v = document.createElement('video')
        v.muted = true // audio is handled separately so volume automation works
        v.playsInline = true
        v.preload = 'auto'
        v.src = this.opts.resolveUrl(layer.assetId!, 'proxy')
        v.addEventListener('waiting', () => this.setWaiting(layer.itemId, true))
        v.addEventListener('playing', () => this.setWaiting(layer.itemId, false))
        v.addEventListener('seeked', () => this.setWaiting(layer.itemId, false))
        content = v
      } else if (layer.type === 'image') {
        const img = document.createElement('img')
        img.src = this.opts.resolveUrl(layer.assetId!, 'media')
        img.decoding = 'async'
        content = img
      } else {
        content = document.createElement('div')
      }
      content.dataset.psContent = '1'
      wrap.appendChild(content)
      this.root.appendChild(wrap)
    }
    let overlay = wrap.querySelector('[data-ps-overlay]') as HTMLDivElement | null
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.dataset.psOverlay = '1'
      overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;background-size:cover'
      wrap.appendChild(overlay)
    }
    if (content instanceof HTMLVideoElement || content instanceof HTMLImageElement) {
      content.style.cssText = MEDIA_FILL
      content.draggable = false
    }
    const el: LayerEl = { wrap, content, overlay, bg, bgMedia, kind: layer.type }
    const still = wrap.querySelector('img[data-ps-hold]') as HTMLImageElement | null
    if (still) el.hold = { until: Number(still.dataset.psHold), still, bgStill: (bg?.querySelector('img[data-ps-hold]') as HTMLImageElement | null) ?? undefined }
    this.layers.set(layer.itemId, el)
    return el
  }

  private ensureBackground(el: LayerEl, layer: FrameLayer) {
    if (!layer.background) {
      if (el.bg) el.bg.style.display = 'none'
      return
    }
    if (!el.bg) {
      const bg = document.createElement('div')
      bg.dataset.psBg = layer.itemId
      bg.style.cssText = 'position:absolute;inset:0;overflow:hidden'
      this.root.insertBefore(bg, el.wrap)
      el.bg = bg
    }
    const bg = el.bg
    bg.style.display = 'block'
    bg.style.zIndex = String(layer.z)
    const fill = layer.background
    if (fill.type === 'color') {
      bg.style.background = fill.color
      if (el.bgMedia) el.bgMedia.style.display = 'none'
    } else if (fill.type === 'image') {
      bg.style.background = `center/cover no-repeat url("${this.opts.resolveUrl(fill.assetId, 'media')}")`
      if (el.bgMedia) el.bgMedia.style.display = 'none'
    } else {
      bg.style.background = '#000'
      if (!el.bgMedia) {
        const src = el.content instanceof HTMLVideoElement || el.content instanceof HTMLImageElement ? el.content.currentSrc || el.content.getAttribute('src') || '' : ''
        const m = el.content instanceof HTMLVideoElement ? Object.assign(document.createElement('video'), { muted: true, playsInline: true, src }) : Object.assign(document.createElement('img'), { src })
        bg.appendChild(m)
        el.bgMedia = m
      }
      el.bgMedia.style.cssText = `position:absolute;inset:-5%;width:110%;height:110%;object-fit:cover;filter:blur(${fill.amount}px) brightness(.8);display:block`
      if (this.opts.mode === 'preview' && el.bgMedia instanceof HTMLVideoElement && layer.mediaTime !== undefined) this.syncVideo(el.bgMedia, layer.mediaTime, layer.itemId, true)
    }
  }

  private drawLayer(layer: FrameLayer, t: number) {
    const el = this.layers.get(layer.itemId) ?? this.createLayer(layer)
    const w = el.wrap
    const auto = layer.box.height <= 0
    w.style.cssText =
      LAYER_BASE +
      `display:block;left:${layer.box.cx.toFixed(2)}px;top:${layer.box.cy.toFixed(2)}px;width:${layer.box.width.toFixed(2)}px;` +
      (auto ? 'height:auto;' : `height:${layer.box.height.toFixed(2)}px;`) +
      `transform:translate(-50%,-50%) ${layer.transform};opacity:${layer.opacity.toFixed(4)};z-index:${layer.z};` +
      (layer.filter ? `filter:${layer.filter};` : '') +
      (layer.blend !== 'normal' ? `mix-blend-mode:${layer.blend};` : '') +
      (layer.clipPath ? `clip-path:${layer.clipPath};` : '')
    el.overlay.style.backgroundImage = layer.overlay ?? 'none'
    el.overlay.style.display = layer.overlay ? 'block' : 'none'
    this.ensureBackground(el, layer)

    if (layer.type === 'video' || layer.type === 'image') {
      const media = el.content as HTMLVideoElement | HTMLImageElement
      if (layer.crop) {
        const c = layer.crop
        media.style.setProperty('object-view-box', `inset(${c.top * 100}% ${c.right * 100}% ${c.bottom * 100}% ${c.left * 100}%)`)
      } else media.style.removeProperty('object-view-box')
      if (el.hold) {
        // before the file starts there is no footage to pre-roll: show the frame the preview holds
        const on = t < el.hold.until
        const { still, bgStill } = el.hold
        still.style.cssText = MEDIA_FILL
        still.style.display = on ? 'block' : 'none'
        const box = media.style.getPropertyValue('object-view-box')
        if (box) still.style.setProperty('object-view-box', box)
        if (bgStill) {
          bgStill.style.cssText = el.bgMedia?.style.cssText || MEDIA_FILL
          bgStill.style.display = on && layer.background?.type === 'blur' ? 'block' : 'none'
        }
      }
      if (layer.type === 'video' && this.opts.mode === 'preview') this.syncVideo(media as HTMLVideoElement, layer.mediaTime ?? 0, layer.itemId)
    } else if (layer.text) {
      const styleKey = JSON.stringify(layer.text.style)
      if (el.lastText !== layer.text.html || el.lastStyle !== styleKey) {
        const bgCss = textBackgroundCss(layer.text.style)
        el.content.style.cssText = textCss(layer.text.style) + ';position:relative;width:100%'
        el.content.innerHTML = bgCss ? `<span style="${escapeHtml(bgCss)}">${layer.text.html}</span>` : layer.text.html
        el.lastText = layer.text.html
        el.lastStyle = styleKey
      }
    } else if (layer.shape) {
      const s = layer.shape
      const fill = safeColor(s.fill, 'transparent')
      el.content.style.cssText =
        `position:absolute;inset:0;background:${s.shape === 'line' ? 'transparent' : fill};` +
        `border-radius:${s.shape === 'ellipse' ? '50%' : `${cssNumber(s.radius)}px`};` +
        (s.stroke ? `border:${cssNumber(s.stroke.width)}px solid ${safeColor(s.stroke.color, 'transparent')};` : '') +
        (s.shape === 'line' ? `border-top:${Math.max(2, cssNumber(s.height))}px solid ${fill};height:0;top:50%;` : '')
    }
  }

  private syncVideo(v: HTMLVideoElement, mediaTime: number, itemId: string, isBg = false) {
    const item = this.findVideoItem(itemId)
    const frozen = item?.freezeAt !== undefined
    const speed = (item?.speed ?? 1) * this.rate
    if (this.playing && !frozen && !item?.reverse) {
      if (Math.abs(v.playbackRate - speed) > 0.001) v.playbackRate = Math.min(16, Math.max(0.0625, speed))
      const drift = Math.abs(v.currentTime - mediaTime)
      if (drift > 0.25) v.currentTime = mediaTime
      if (v.paused) void v.play().catch(() => undefined)
    } else {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - mediaTime) > 0.01) v.currentTime = mediaTime
    }
    void isBg
  }

  private findVideoItem(id: string): VideoItem | undefined {
    for (const t of this.project.tracks) for (const i of t.items) if (i.id === id && i.type === 'video') return i
    return undefined
  }

  private syncAudio(levels: ReturnType<typeof evaluate>['audio'], t: number) {
    const active = new Set<string>()
    for (const a of levels) {
      active.add(a.itemId)
      let el = this.audioEls.get(a.itemId)
      if (!el) {
        el = new Audio(this.opts.resolveUrl(a.assetId, 'media'))
        el.preload = 'auto'
        this.audioEls.set(a.itemId, el)
      }
      el.volume = Math.min(1, Math.max(0, a.volume))
      if (this.playing) {
        const rate = Math.min(16, Math.max(0.0625, a.speed * this.rate))
        if (Math.abs(el.playbackRate - rate) > 0.001) el.playbackRate = rate
        if (Math.abs(el.currentTime - a.mediaTime) > 0.3) el.currentTime = a.mediaTime
        if (el.paused) void el.play().catch(() => undefined)
      } else if (!el.paused) el.pause()
    }
    for (const [id, el] of this.audioEls) if (!active.has(id) && !el.paused) el.pause()
    void t
  }

  private setWaiting(id: string, on: boolean) {
    if (on) this.waiting.add(id)
    else this.waiting.delete(id)
    this.opts.onBuffering?.(this.waiting.size > 0)
  }
}

/** Item time window a media element must cover in export, including transition pre-roll / hold. */
export function exportWindow(p: Project, trackIdx: number, itemIdx: number): { start: number; end: number } {
  const track = p.tracks[trackIdx]
  const it = track.items[itemIdx]
  let start = it.start
  let end = itemEnd(it)
  const prev = track.items[itemIdx - 1]
  const prevTr = prev && 'transitionOut' in prev ? prev.transitionOut : undefined
  if (prevTr && Math.abs(itemEnd(prev) - it.start) < 0.05) start -= Math.min(prevTr.duration / 2, prev.duration / 2, it.duration / 2)
  const tr = 'transitionOut' in it ? it.transitionOut : undefined
  const next = track.items[itemIdx + 1]
  if (tr && next && Math.abs(next.start - end) < 0.05) end += Math.min(tr.duration / 2, it.duration / 2, next.duration / 2)
  return { start: Math.max(0, start), end }
}

export interface ExportVideoTiming {
  /** The export window (see exportWindow). */
  start: number
  end: number
  /** When the file starts playing, and where in it (source seconds; 0 for a reversed copy). */
  from: number
  mediaStart: number
  /**
   * Before `from` the source has no footage to pre-roll into the transition: like the preview, the picture holds the
   * frame at source `at` until then.
   */
  hold?: { until: number; at: number }
  /** A reversed clip plays a server-made copy of source `from`..`to`, run backwards. */
  reversed?: { from: number; to: number }
}

/**
 * How a video item's file covers its export window so every frame shows what the preview shows: the pre-roll into
 * an incoming transition plays only footage the source has before the clip's first frame (after it, for a reversed
 * clip), then a held frame covers the rest.
 */
export function exportVideoTiming(p: Project, trackIdx: number, itemIdx: number): ExportVideoTiming {
  const it = p.tracks[trackIdx].items[itemIdx] as VideoItem
  const win = exportWindow(p, trackIdx, itemIdx)
  const dur = p.assets[it.assetId]?.duration
  const known = dur !== undefined && Number.isFinite(dur) && dur > 0
  const pre = it.start - win.start
  const post = win.end - itemEnd(it)
  const span = it.duration * it.speed
  // footage before the clip's first frame: the source before its in-point, or after its range when reversed
  const before = it.reverse ? (known ? Math.max(0, dur - (it.in + span)) : 0) : it.in
  const lead = Math.min(pre, before / it.speed)
  const from = it.start - lead
  const out: ExportVideoTiming = { start: win.start, end: win.end, from, mediaStart: it.reverse ? 0 : Math.max(0, it.in - lead * it.speed) }
  if (it.reverse) out.reversed = { from: Math.max(0, it.in - post * it.speed), to: it.in + span + lead * it.speed }
  if (from - win.start > 1e-3) {
    const at = it.reverse ? it.in + span + pre * it.speed : it.in - pre * it.speed
    out.hold = { until: from, at: Math.min(Math.max(0, at), known ? dur : Infinity) }
  }
  return out
}
