// DOM renderer for evaluated frames. The editor preview uses it in 'preview' mode (it owns <video>/<audio>
// playback); the HyperFrames export bundles it in 'export' mode (media elements are pre-declared in the
// composition and HyperFrames owns their playback, the renderer only positions and styles them).
import { evaluate, textBoxCss, textInnerHtml } from './evaluate'
import { itemEnd, projectDuration } from './ops'
import { fitScale, scaledTextStyle } from './text'
import type { FrameLayer, Item, Project, TextStyle, Track, VideoItem } from './types'
import { cssNumber, safeColor } from './util'

/** `audio`: what the preview plays a clip's sound from (for a video, its small sound-only copy when there is one). */
export type UrlResolver = (assetId: string, kind: 'media' | 'proxy' | 'audio') => string

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
  lastFill?: string
  /** Shrink to fit: what the scale was measured for, and the scale. */
  lastFitKey?: string
  fitK?: number
}

/** The loudest a clip plays (+12 dB), in the preview as in the export. */
export const MAX_GAIN = 3.98

interface Voice {
  el: HTMLAudioElement
  /** Web Audio gain the element plays through: levels above 100 % are heard as the export renders them. */
  gain?: GainNode
}

/**
 * Preview: a browser allows only so many media players at once (Chrome about 75), so a clip's players are made
 * shortly before it plays and released once the playhead is well past or before it.
 */
const PRELOAD_AHEAD = 4
const KEEP_BEHIND = 8
/** How many upcoming video clips get their player ahead of time. */
const PRELOAD_VIDEOS = 2

/** Further off the playhead than this (seconds), a playing element seeks; closer, it changes speed a little. */
const SEEK_DRIFT = 0.5

/**
 * Playback rate that pulls a playing element back onto the playhead without a seek: up to 10 % faster or slower, in
 * 2 % steps so the rate doesn't change every frame. `drift` is how far ahead of the playhead the element is (seconds).
 */
export function followRate(speed: number, drift: number): number {
  const k = Math.round(Math.max(-0.1, Math.min(0.1, drift * 0.5)) / 0.02) * 0.02
  return Math.min(16, Math.max(0.0625, speed * (1 - k)))
}

const LAYER_BASE = 'position:absolute;transform-origin:50% 50%;will-change:transform,opacity;'
const MEDIA_FILL = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill;display:block'

export class StageRenderer {
  readonly root: HTMLElement
  private project: Project
  private opts: RendererOptions
  private layers = new Map<string, LayerEl>()
  private voices = new Map<string, Voice>()
  /** undefined until the first sound; null where Web Audio isn't available. */
  private audioCtx?: AudioContext | null
  private playing = false
  private rate = 1
  private waiting = new Set<string>()
  private items = new Map<string, { item: Item; track: Track }>()
  private rendering = false
  private bufferChanged = false
  private lastT?: number
  private primed = new Set<string>()
  private onFonts?: () => void

  constructor(root: HTMLElement, project: Project, opts: RendererOptions) {
    this.root = root
    this.project = project
    this.opts = opts
    this.index()
    root.style.position = 'relative'
    root.style.overflow = 'hidden'
    root.style.background = safeColor(project.background, '#000000')
    // a font that arrives changes how text measures: draw (and fit) it again
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (fonts?.addEventListener) {
      this.onFonts = () => {
        for (const el of this.layers.values()) el.lastText = el.lastFitKey = undefined
        if (this.lastT !== undefined && !this.rendering) this.render(this.lastT)
      }
      fonts.addEventListener('loadingdone', this.onFonts)
    }
    this.primeFonts()
  }

  setProject(p: Project) {
    this.project = p
    this.root.style.background = safeColor(p.background, '#000000')
    this.index()
    this.primeFonts()
    // drop elements for items that no longer exist
    for (const [id, el] of this.layers) if (!this.items.has(id)) this.removeLayer(id, el)
    for (const id of [...this.voices.keys()]) if (!this.items.has(id)) this.dropVoice(id)
  }

  private index() {
    this.items.clear()
    for (const track of this.project.tracks) for (const item of track.items) this.items.set(item.id, { item, track })
  }

  get duration() {
    return projectDuration(this.project)
  }

  /** Preview only: mark transport state so media elements play natively between frames. */
  setPlaying(playing: boolean, rate = 1) {
    this.playing = playing
    this.rate = rate
    if (!playing) {
      for (const el of this.layers.values()) for (const m of [el.content, el.bgMedia]) if (m instanceof HTMLVideoElement) m.pause()
      for (const a of this.voices.values()) a.el.pause()
      // stopped, nothing is waiting to play
      if (this.waiting.size) {
        this.waiting.clear()
        this.opts.onBuffering?.(false)
      }
    } else if (this.audioCtx?.state === 'suspended') void this.audioCtx.resume().catch(() => undefined)
  }

  render(t: number) {
    this.lastT = t
    this.rendering = true
    try {
      this.draw(t)
    } finally {
      this.rendering = false
    }
    // told once the frame is drawn: the listener may render again
    if (this.bufferChanged) {
      this.bufferChanged = false
      this.opts.onBuffering?.(this.waiting.size > 0)
    }
  }

  private draw(t: number) {
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
        if (this.opts.mode === 'preview') {
          for (const m of [el.content, el.bgMedia]) if (m instanceof HTMLVideoElement && !m.paused) m.pause()
          // a clip that has ended isn't something to wait for
          this.setWaiting(id, false)
        }
      }
    }
    if (this.opts.mode === 'preview') {
      this.syncAudio(frame.audio, t)
      this.releaseFar(t)
      this.preloadAhead(t)
    }
  }

  /** Whether an item's players are worth keeping at time t. */
  private near(id: string, t: number): boolean {
    const it = this.items.get(id)?.item
    return !!it && t >= it.start - PRELOAD_AHEAD - 0.5 && t <= itemEnd(it) + KEEP_BEHIND
  }

  /** Preview: free the players of clips far from the playhead. */
  private releaseFar(t: number) {
    for (const [id, el] of this.layers) if (el.kind === 'video' && el.wrap.style.display === 'none' && !this.near(id, t)) this.removeLayer(id, el)
    for (const [id, v] of [...this.voices]) if (v.el.paused && !this.near(id, t)) this.dropVoice(id)
  }

  /** Preview: make the players of the next clips before they start, parked on their first frame. */
  private preloadAhead(t: number) {
    const soon: VideoItem[] = []
    for (const track of this.project.tracks) {
      if (track.kind === 'audio') {
        if (track.muted) continue
        for (const it of track.items)
          if (it.type === 'audio' && !it.muted && it.start > t && it.start - t <= PRELOAD_AHEAD && !this.voices.has(it.id)) this.createVoice(it.id, it.assetId).el.currentTime = it.in
        continue
      }
      if (track.kind === 'caption') continue
      for (const it of track.items) if (it.type === 'video' && it.start > t && it.start - t <= PRELOAD_AHEAD) soon.push(it)
    }
    soon.sort((a, b) => a.start - b.start)
    for (const it of soon.slice(0, PRELOAD_VIDEOS)) {
      const track = this.items.get(it.id)?.track
      if (!this.layers.has(it.id) && !track?.hidden) {
        const el = this.createLayer({ itemId: it.id, type: 'video', assetId: it.assetId } as FrameLayer)
        el.wrap.style.display = 'none'
        const v = el.content as HTMLVideoElement
        v.currentTime = it.freezeAt ?? (it.reverse ? it.in + it.duration * it.speed : it.in)
      }
      const silent = it.muted || track?.muted || it.reverse || it.freezeAt !== undefined || this.project.assets[it.assetId]?.hasAudio === false
      if (!silent && !this.voices.has(it.id)) this.createVoice(it.id, it.assetId).el.currentTime = it.in
    }
  }

  /**
   * Preview: the timeline time the sound (or else the picture) that is playing has reached, for the transport clock
   * to follow; undefined while nothing plays steadily.
   */
  mediaClock(): number | undefined {
    if (!this.playing || this.waiting.size) return undefined
    const at = (id: string, m: HTMLMediaElement) => {
      const it = this.items.get(id)?.item
      if (!it || (it.type !== 'audio' && it.type !== 'video') || m.paused || m.seeking || m.readyState < 3) return undefined
      if (it.type === 'video' && (it.reverse || it.freezeAt !== undefined)) return undefined
      const t = it.start + (m.currentTime - it.in) / it.speed
      return t >= it.start && t <= itemEnd(it) ? t : undefined
    }
    for (const [id, v] of this.voices) {
      const t = at(id, v.el)
      if (t !== undefined) return t
    }
    for (const [id, el] of this.layers) {
      const t = el.content instanceof HTMLVideoElement && el.wrap.style.display !== 'none' ? at(id, el.content) : undefined
      if (t !== undefined) return t
    }
    return undefined
  }

  destroy() {
    if (this.onFonts) document.fonts?.removeEventListener('loadingdone', this.onFonts)
    for (const [id, el] of this.layers) this.removeLayer(id, el)
    for (const id of [...this.voices.keys()]) this.dropVoice(id)
    if (this.waiting.size) {
      this.waiting.clear()
      this.opts.onBuffering?.(false)
    }
    void this.audioCtx?.close().catch(() => undefined)
    this.audioCtx = undefined
  }

  private removeLayer(id: string, el: LayerEl) {
    for (const m of [el.content, el.bgMedia])
      if (m instanceof HTMLVideoElement) {
        m.pause()
        if (this.opts.mode === 'preview') release(m)
      }
    if (this.opts.mode === 'preview') {
      el.wrap.remove()
      el.bg?.remove()
      this.setWaiting(id, false)
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
        v.addEventListener('waiting', () => this.playing && this.layers.get(layer.itemId)?.content === v && this.setWaiting(layer.itemId, true))
        for (const ev of ['playing', 'seeked', 'error']) v.addEventListener(ev, () => this.setWaiting(layer.itemId, false))
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
      (layer.clipPath ? `clip-path:${layer.clipPath};` : '') +
      (layer.crop ? 'overflow:hidden;' : '')
    el.overlay.style.backgroundImage = layer.overlay ?? 'none'
    el.overlay.style.display = layer.overlay ? 'block' : 'none'
    this.ensureBackground(el, layer)

    if (layer.type === 'video' || layer.type === 'image') {
      const media = el.content as HTMLVideoElement | HTMLImageElement
      // the layer box is the cropped size: the whole frame is drawn larger behind it and the box clips it
      // (object-view-box would do it in one property, but only Chromium draws it)
      const fill = cropFill(layer.crop)
      if (el.lastFill !== fill) {
        media.style.cssText = fill
        el.lastFill = fill
      }
      if (el.hold) {
        // before the file starts there is no footage to pre-roll: show the frame the preview holds
        const on = t < el.hold.until
        const { still, bgStill } = el.hold
        still.style.cssText = fill
        still.style.display = on ? 'block' : 'none'
        if (bgStill) {
          bgStill.style.cssText = el.bgMedia?.style.cssText || MEDIA_FILL
          bgStill.style.display = on && layer.background?.type === 'blur' ? 'block' : 'none'
        }
      }
      if (layer.type === 'video' && this.opts.mode === 'preview') this.syncVideo(media as HTMLVideoElement, layer.mediaTime ?? 0, layer.itemId)
    } else if (layer.text) {
      const st = layer.text.style
      const styleKey = JSON.stringify(st)
      const fit = st.fit && st.fit.height > 0 ? st.fit.height : 0
      const fitKey = fit ? `${layer.text.full ?? layer.text.html}|${styleKey}|${layer.box.width}` : undefined
      if (el.lastText !== layer.text.html || el.lastStyle !== styleKey || el.lastFitKey !== fitKey) {
        // shrink to fit: measured once per text, style and box (the same search in the preview and the export)
        if (fit && el.lastFitKey !== fitKey) el.fitK = this.measureFit(el.content, layer.text.full ?? layer.text.html, st, layer.box.width, fit)
        const drawn = fit && (el.fitK ?? 1) < 1 ? scaledTextStyle(st, el.fitK!) : st
        el.content.style.cssText = textBoxCss(drawn, !!fit)
        el.content.innerHTML = textInnerHtml(drawn, layer.text.html)
        el.lastText = layer.text.html
        el.lastStyle = styleKey
        el.lastFitKey = fitKey
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

  /** The scale at which `html` fits a width × height box, measured in the content element itself. */
  private measureFit(content: HTMLElement, html: string, style: TextStyle, width: number, height: number): number {
    return fitScale((k) => {
      const s = k < 1 ? scaledTextStyle(style, k) : style
      content.style.cssText = textBoxCss(s, true)
      content.innerHTML = textInnerHtml(s, html)
      return content.scrollHeight <= height + 0.5 && content.scrollWidth <= width + 0.5
    })
  }

  /**
   * Ask for every face the project's text uses straight away, so a page waiting on document.fonts (the export)
   * waits for them all, and text first drawn later is measured in its own font.
   */
  private primeFonts() {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts?.load) return
    const ask = (family: string, weight: number, italic: boolean) => {
      const key = `${italic ? 'italic ' : ''}${Math.round(cssNumber(weight, 400))} 16px "${String(family ?? '').replace(/["\\;{}<>]/g, '')}"`
      if (this.primed.has(key)) return
      this.primed.add(key)
      void fonts.load(key).catch(() => undefined)
    }
    for (const track of this.project.tracks) {
      if (track.captionStyle) ask(track.captionStyle.style.fontFamily, track.captionStyle.style.fontWeight, track.captionStyle.style.italic)
      for (const it of track.items)
        if (it.type === 'text') {
          ask(it.style.fontFamily, it.style.fontWeight, it.style.italic)
          for (const s of it.spans ?? []) ask(it.style.fontFamily, s.fontWeight ?? it.style.fontWeight, s.italic ?? it.style.italic)
        }
    }
  }

  /** Preview: another element is still loading, so this one waits for it (the transport clock waits too). */
  private held(key: string): boolean {
    return this.waiting.size > 0 && !this.waiting.has(key)
  }

  private syncVideo(v: HTMLVideoElement, mediaTime: number, itemId: string, isBg = false) {
    const item = this.findVideoItem(itemId)
    const frozen = item?.freezeAt !== undefined
    const speed = (item?.speed ?? 1) * this.rate
    if (this.playing && !frozen && !item?.reverse && !this.held(isBg ? `bg:${itemId}` : itemId)) {
      const drift = v.currentTime - mediaTime
      const far = Math.abs(drift) > SEEK_DRIFT * speed
      if (far) v.currentTime = mediaTime
      const rate = followRate(speed, far ? 0 : drift / speed)
      if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate
      if (v.paused) void v.play().catch(() => undefined)
    } else {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - mediaTime) > 0.01) v.currentTime = mediaTime
    }
  }

  private findVideoItem(id: string): VideoItem | undefined {
    const it = this.items.get(id)?.item
    return it?.type === 'video' ? it : undefined
  }

  private context(): AudioContext | null {
    if (this.audioCtx === undefined) {
      const w = typeof window !== 'undefined' ? (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }) : undefined
      const Ctx = w?.AudioContext ?? w?.webkitAudioContext
      try {
        this.audioCtx = Ctx ? new Ctx() : null
      } catch {
        this.audioCtx = null
      }
    }
    return this.audioCtx
  }

  /**
   * A clip's sound. Where Web Audio is available it plays through a gain node, so 150 % sounds like the export's
   * 150 % (an element's own volume stops at 100 %). That needs the file to answer CORS; if it doesn't, the element
   * fails and is replaced by a plain one, which plays at most at 100 %.
   */
  private createVoice(itemId: string, assetId: string, plain = false): Voice {
    const url = this.opts.resolveUrl(assetId, 'audio')
    const el = new Audio()
    el.preload = 'auto'
    const ctx = plain ? null : this.context()
    const voice: Voice = { el }
    const key = `a:${itemId}`
    el.addEventListener('waiting', () => this.playing && this.voices.get(itemId) === voice && this.setWaiting(key, true))
    for (const ev of ['playing', 'seeked', 'error']) el.addEventListener(ev, () => this.setWaiting(key, false))
    if (ctx) {
      try {
        el.crossOrigin = 'anonymous'
        const gain = ctx.createGain()
        ctx.createMediaElementSource(el).connect(gain)
        gain.connect(ctx.destination)
        voice.gain = gain
        el.addEventListener('error', () => this.voices.get(itemId) === voice && this.replaceVoice(itemId, assetId), { once: true })
      } catch {
        el.removeAttribute('crossorigin')
      }
    }
    el.src = url
    this.voices.set(itemId, voice)
    return voice
  }

  private replaceVoice(itemId: string, assetId: string) {
    const was = this.voices.get(itemId)
    this.dropVoice(itemId)
    const v = this.createVoice(itemId, assetId, true)
    if (was) v.el.currentTime = was.el.currentTime
  }

  private dropVoice(itemId: string) {
    const v = this.voices.get(itemId)
    if (!v) return
    v.el.pause()
    release(v.el)
    v.gain?.disconnect()
    this.voices.delete(itemId)
    this.setWaiting(`a:${itemId}`, false)
  }

  private syncAudio(levels: ReturnType<typeof evaluate>['audio'], t: number) {
    const active = new Set<string>()
    for (const a of levels) {
      active.add(a.itemId)
      const voice = this.voices.get(a.itemId) ?? this.createVoice(a.itemId, a.assetId)
      const el = voice.el
      const level = Math.min(MAX_GAIN, Math.max(0, a.volume))
      if (voice.gain) {
        if (Math.abs(voice.gain.gain.value - level) > 1e-4) voice.gain.gain.value = level
        if (el.volume !== 1) el.volume = 1
      } else el.volume = Math.min(1, level)
      if (this.playing && !this.held(`a:${a.itemId}`)) {
        const speed = a.speed * this.rate
        // small drifts are taken up by the rate, so the sound doesn't skip (captions follow the playhead)
        const drift = el.currentTime - a.mediaTime
        const far = Math.abs(drift) > SEEK_DRIFT * speed
        if (far) el.currentTime = a.mediaTime
        const rate = followRate(speed, far ? 0 : drift / speed)
        if (Math.abs(el.playbackRate - rate) > 0.001) el.playbackRate = rate
        if (el.paused) void el.play().catch(() => undefined)
      } else if (!el.paused) el.pause()
    }
    for (const [id, v] of this.voices)
      if (!active.has(id)) {
        if (!v.el.paused) v.el.pause()
        this.setWaiting(`a:${id}`, false)
      }
    void t
  }

  private setWaiting(id: string, on: boolean) {
    if (on === this.waiting.has(id)) return
    if (on) this.waiting.add(id)
    else this.waiting.delete(id)
    if (this.rendering) this.bufferChanged = true
    else this.opts.onBuffering?.(this.waiting.size > 0)
  }
}

/** Style that draws a whole frame so that only its uncropped part shows inside the layer box (which clips it). */
export function cropFill(crop: FrameLayer['crop']): string {
  if (!crop || (!crop.left && !crop.right && !crop.top && !crop.bottom)) return MEDIA_FILL
  const w = Math.max(0.01, 1 - crop.left - crop.right)
  const h = Math.max(0.01, 1 - crop.top - crop.bottom)
  const pct = (v: number) => `${+(v * 100).toFixed(4)}%`
  return `position:absolute;left:${pct(-crop.left / w)};top:${pct(-crop.top / h)};width:${pct(1 / w)};height:${pct(1 / h)};max-width:none;object-fit:fill;display:block`
}

/** Free a media element's player: without its source (and a reload) the browser keeps the decoder. */
function release(m: HTMLMediaElement) {
  m.removeAttribute('src')
  try {
    m.load()
  } catch {
    /* nothing loaded */
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
