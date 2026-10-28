// Centre canvas: StageRenderer preview + selection overlay (move / scale / rotate / text width / crop), snapping to
// the canvas, guides, safe zones and other objects, group transforms, inline text editing, floating object toolbar,
// rulers, hand/zoom, drop target for media.
import type { FrameLayer, ImageItem, Item, Project, TextItem, VideoItem, VisualItem } from '@producer/core'
import { StageRenderer, editable, evaluate, findItem, resetTransform, setTextContent, textCss, updateItem, updateTrack } from '@producer/core'
import clsx from 'clsx'
import { Copy, Crop, FlipHorizontal2, FlipVertical2, Loader2, Maximize, Minimize, MoreHorizontal, RotateCcw, Scissors, ClipboardPaste, Trash2, CopyPlus } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { tipProps } from '../lib/tooltip'
import * as A from './actions'
import { AlignButtons } from './AlignTools'
import { layerBoxes, parseTransform } from './canvasActions'
import { CanvasRulers, CanvasViewBar, SafeZoneOverlay, SnapLines } from './CanvasGuides'
import { safeRect, shift, snapBox, snapTargets, union, type Box } from './canvasSnap'
import { SmartCanvasOverlay } from './SmartCanvas'
import { useCanvasView } from './canvasView'
import { Menu, MenuItem, Slider, useThrottledPlayhead } from './controls'
import { dragPayload, isInternalDrag, makeResolver } from './media'
import { applyTransport, setMediaClock } from './playback'
import { useEditor } from './store'
import { previewVariant, useTransport } from './transport'

const NO_LINES = { x: [] as number[], y: [] as number[] }
/** How close (screen px) an edge comes before it snaps. */
const SNAP_PX = 6

interface Geo {
  layer: FrameLayer
  item: Item
  cx: number
  cy: number
  w: number
  h: number
  rot: number
  /** The item or its track is locked: no handles, no toolbar. */
  locked: boolean
}

/** What the canvas draws: a saved version on show from Version history (read-only), else the document. */
const onCanvas = (s: { project: Project; versionPreview?: { project: Project } }) => s.versionPreview?.project ?? s.project

export function Canvas() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const W = useEditor((s) => s.project.width)
  const H = useEditor((s) => s.project.height)
  const canvasZoom = useEditor((s) => s.canvasZoom)
  const tool = useEditor((s) => s.canvasTool)
  const buffering = useEditor((s) => s.buffering)
  const editingTextId = useEditor((s) => s.editingTextId)
  const fullscreen = useEditor((s) => s.fullscreen)
  const fullQuality = useTransport((t) => t.fullQuality)
  const [avail, setAvail] = useState({ w: 800, h: 450 })
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [snapLines, setSnapLines] = useState(NO_LINES)
  const [dropping, setDropping] = useState(false)
  const [loadingMedia, setLoadingMedia] = useState(0)
  const projectId = useEditor((s) => s.projectId)
  useEffect(() => useCanvasView.getState().openProject(projectId), [projectId])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setAvail({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setAvail({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const pad = fullscreen ? 0 : 40
  const fit = Math.max(0.05, Math.min((avail.w - pad) / W, (avail.h - pad) / H))
  const scale = canvasZoom === 'fit' ? fit : canvasZoom
  useEffect(() => {
    if (canvasZoom === 'fit') setPan({ x: 0, y: 0 })
  }, [canvasZoom])
  // expose the fit scale to the zoom menu
  useEffect(() => {
    useEditor.setState({ canvasFit: fit })
  }, [fit])

  // renderer lifecycle + subscriptions (no React re-render per frame)
  useEffect(() => {
    const root = stageRef.current!
    const st = useEditor.getState()
    const resolve = makeResolver(() => onCanvas(useEditor.getState()))
    const r = new StageRenderer(root, onCanvas(st), {
      mode: 'preview',
      resolveUrl: (id, kind) => resolve(id, previewVariant(kind)),
      onBuffering: (b) => useEditor.setState({ buffering: b }),
    })
    applyTransport(r, st.playing)
    r.render(st.playhead)
    setMediaClock(() => r.mediaClock())
    // a shuttle or preview speed change while playing
    const unsubTransport = useTransport.subscribe((t, prev) => (t.shuttle !== prev.shuttle || t.speed !== prev.speed) && applyTransport(r, useEditor.getState().playing))
    let disposed = false
    const media = watchMediaLoading(root, setLoadingMedia, () => !disposed && r.render(useEditor.getState().playhead))
    const unsub = useEditor.subscribe((s, prev) => {
      const pc = onCanvas(s) !== onCanvas(prev)
      if (pc) r.setProject(onCanvas(s))
      if (s.playing !== prev.playing) applyTransport(r, s.playing)
      // buffering starts or ends: the other media pause for it, or carry on
      if (pc || s.playhead !== prev.playhead || s.playing !== prev.playing || s.buffering !== prev.buffering) {
        r.render(s.playhead)
        media.recount()
      }
    })
    // re-render once fonts are ready so text measures correctly
    void document.fonts?.ready.then(() => !disposed && r.render(useEditor.getState().playhead))
    return () => {
      disposed = true
      setMediaClock(null)
      media.stop()
      unsub()
      unsubTransport()
      r.destroy()
    }
    // full-quality preview loads the original files: a new renderer
  }, [fullQuality])

  // full-screen preview
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    if (fullscreen && !document.fullscreenElement) void el.requestFullscreen?.().catch(() => useEditor.setState({ fullscreen: false }))
    if (!fullscreen && document.fullscreenElement) void document.exitFullscreen?.()
    const onChange = () => !document.fullscreenElement && useEditor.setState({ fullscreen: false })
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [fullscreen])

  const hitTest = useCallback((x: number, y: number): string | null => {
    const root = stageRef.current
    if (!root) return null
    for (const el of document.elementsFromPoint(x, y)) {
      if (!root.contains(el)) continue
      const layer = (el as HTMLElement).closest('[data-ps-layer]') as HTMLElement | null
      if (layer && root.contains(layer)) return layer.dataset.psLayer ?? null
    }
    return null
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    // a saved version on show (Version history) is read-only: pan, but nothing to pick
    if (useEditor.getState().versionPreview && e.button !== 1 && tool !== 'hand') return
    if (e.button === 1 || tool === 'hand') {
      startPan(e)
      return
    }
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.cv-handle, .cv-toolbar, .cv-textedit, .ed-menu, .cv-ruler, .cv-gline, .cv-viewbar')) return
    wrapRef.current?.focus({ preventScroll: true })
    const s = useEditor.getState()
    const id = hitTest(e.clientX, e.clientY)
    if (!id) {
      if (s.editingTextId) return
      s.select([])
      return
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      s.select(s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id])
      return
    }
    // dragging one of several selected objects moves them all; a click without a drag selects just that one
    if (s.selection.length > 1 && s.selection.includes(id)) return beginMove(e, id, s.selection)
    if (!s.selection.includes(id)) s.select([id])
    if (s.editingTextId && s.editingTextId !== id) s.set({ editingTextId: null })
    beginMove(e, id)
  }

  const startPan = (e: React.PointerEvent) => {
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    const o = { ...pan }
    if (canvasZoom === 'fit') useEditor.setState({ canvasZoom: fit })
    const move = (ev: PointerEvent) => setPan({ x: o.x + ev.clientX - sx, y: o.y + ev.clientY - sy })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * Drag an item's position (or a caption track's vertical position); with `group`, every movable object of the
   * group moves together. The moving bounds snap to the canvas edges and centre, guides, the safe area and the other
   * objects (with snapping on; Alt held moves freely).
   */
  const beginMove = (e: React.PointerEvent, id: string, group?: string[]) => {
    const s0 = useEditor.getState()
    const f = findItem(s0.project, id)
    if (!editable(f)) {
      if (group) s0.select([id])
      return
    }
    const orig = s0.project
    const it = f.item
    const sx = e.clientX
    const sy = e.clientY
    const sc = scale
    const t = s0.playhead
    let moved = false
    const finish = (move: (ev: PointerEvent) => void) => {
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setSnapLines(NO_LINES)
        useEditor.getState().endCoalesce()
        if (!moved && group) useEditor.getState().select([id])
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }
    if (it.type === 'caption') {
      const oy = (f.track.captionStyle?.position ?? 0.86) * H
      return finish((ev) => {
        const dy = (ev.clientY - sy) / sc
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return
        moved = true
        const pos = Math.max(0.05, Math.min(0.95, (oy + dy) / H))
        const cs = f.track.captionStyle
        if (cs) useEditor.getState().commit(updateTrack(orig, f.track.id, { captionStyle: { ...cs, position: +pos.toFixed(4) } }), 'Move captions', { coalesce: `cmove:${f.track.id}` })
      })
    }
    const ids = (group ?? [id]).filter((x) => {
      const g = findItem(orig, x)
      return editable(g) && 'transform' in g.item
    })
    const start = new Map(ids.map((x) => [x, { x: A.readProp(findItem(orig, x)!.item, 'x', t), y: A.readProp(findItem(orig, x)!.item, 'y', t) }]))
    const boxes = layerBoxes(orig, t)
    const mine: Box | null = union(boxes.filter((b) => start.has(b.id)))
    const view = useCanvasView.getState()
    const targets = snapTargets(W, H, boxes.filter((b) => !start.has(b.id)), view.rulers ? view.guides : undefined, view.safeZone ? safeRect(view.safeZone, W, H) : null)
    finish((ev) => {
      let dx = (ev.clientX - sx) / sc
      let dy = (ev.clientY - sy) / sc
      if (!moved && Math.hypot(dx * sc, dy * sc) < 3) return
      moved = true
      let lockX = false
      let lockY = false
      if (ev.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) (dy = 0), (lockY = true)
        else (dx = 0), (lockX = true)
      }
      const s = useEditor.getState()
      let lines = NO_LINES
      if (mine && s.snapping && !ev.altKey) {
        const snap = snapBox(shift(mine, dx, dy), targets, SNAP_PX / sc)
        if (!lockX) dx += snap.dx
        if (!lockY) dy += snap.dy
        lines = { x: lockX ? [] : snap.lines.x, y: lockY ? [] : snap.lines.y }
      }
      setSnapLines(lines)
      let p = orig
      for (const [x, o] of start) {
        p = A.writeProp(p, x, 'x', Math.round(o.x + dx), t)
        p = A.writeProp(p, x, 'y', Math.round(o.y + dy), t)
      }
      s.commit(p, start.size > 1 ? 'Move objects' : 'Move', { coalesce: `move:${[...start.keys()].join(',')}` })
    })
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const id = hitTest(e.clientX, e.clientY)
    if (!id || useEditor.getState().versionPreview) return
    const f = findItem(useEditor.getState().project, id)
    if (f?.item.type === 'text' && editable(f)) useEditor.setState({ selection: [id], editingTextId: id, playing: false })
    if (f?.item.type === 'caption') useEditor.setState({ selection: [id], activeRightTab: 'caption' })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.key.startsWith('Arrow') || e.ctrlKey || e.metaKey || e.altKey) return
    if ((e.target as HTMLElement).closest('input, textarea')) return
    const s = useEditor.getState()
    const items = s.selection.map((id) => findItem(s.project, id)).filter((f) => editable(f) && 'transform' in f.item).map((f) => f!.item)
    if (!items.length) return
    e.preventDefault()
    e.stopPropagation()
    const d = e.shiftKey ? 10 : 1
    const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0
    const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0
    let p = s.project
    for (const it of items) {
      if (dx) p = A.writeProp(p, it.id, 'x', A.readProp(it, 'x') + dx)
      if (dy) p = A.writeProp(p, it.id, 'y', A.readProp(it, 'y') + dy)
    }
    s.commit(p, 'Nudge', { coalesce: `nudge:${items.map((i) => i.id).join(',')}` })
  }

  // ctrl+wheel zoom (native non-passive listener so the browser page zoom is blocked)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const next = Math.max(0.1, Math.min(4, scaleRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
      useEditor.setState({ canvasZoom: +next.toFixed(3) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onDragOver = (e: React.DragEvent) => {
    const p = dragPayload()
    if (!isInternalDrag(e) || !p || (p.kind !== 'asset' && p.kind !== 'text')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDrop = (e: React.DragEvent) => {
    setDropping(false)
    const p = dragPayload()
    if (!p) return
    e.preventDefault()
    const s = useEditor.getState()
    if (p.kind === 'asset') {
      const main = s.project.tracks.find((t) => t.main)
      const occupied = !!main?.items.length
      A.addAssetAt(p.asset, s.playhead, { overlay: occupied && p.asset.kind !== 'audio' })
    } else if (p.kind === 'text') A.addText(p.templateId)
  }

  return (
    <div
      ref={wrapRef}
      className={clsx('cv-wrap', tool === 'hand' && 'hand', dropping && 'dropping', fullscreen && 'fs')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      data-canvas
    >
      <div ref={boxRef} className="cv-box" style={{ width: W * scale, height: H * scale, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        <div className="cv-scaler" style={{ width: W, height: H, transform: `scale(${scale})` }}>
          <div ref={stageRef} className="cv-stage" style={{ width: W, height: H }} />
          {editingTextId && <InlineTextEditor id={editingTextId} />}
        </div>
        {!fullscreen && <SafeZoneOverlay W={W} H={H} scale={scale} />}
        <SnapLines lines={snapLines} scale={scale} />
        {!fullscreen && <CanvasRulers W={W} H={H} scale={scale} boxRef={boxRef} />}
        {!fullscreen && <SelectionOverlay scale={scale} boxRef={boxRef} beginMove={beginMove} margin={Math.max(0, (avail.h - H * scale) / 2 + pan.y)} />}
        {!fullscreen && <GroupOverlay scale={scale} boxRef={boxRef} margin={Math.max(0, (avail.h - H * scale) / 2 + pan.y)} />}
        {!fullscreen && <SmartCanvasOverlay scale={scale} boxRef={boxRef} />}
      </div>
      {!fullscreen && <CanvasViewBar />}
      {(buffering || loadingMedia > 0) && (
        <div className="cv-buffering">
          <Loader2 size={14} className="spin" /> {loadingMedia > 0 ? `Loading media${loadingMedia > 1 ? ` (${loadingMedia})` : ''}…` : 'Buffering'}
        </div>
      )}
      {fullscreen && (
        <button className="btn sm cv-exit-fs" {...tipProps('Exit full screen', undefined, 'Esc')} onClick={() => useEditor.setState({ fullscreen: false })}>
          <Minimize size={14} /> Exit full screen
        </button>
      )}
    </div>
  )
}

/**
 * Media may not be available yet (desktop mode downloads lazily and answers 404/202; server proxies may still be
 * rendering). When a <video>/<img> inside the stage fails, mark its layer as loading and retry with backoff.
 */
function watchMediaLoading(root: HTMLElement, report: (n: number) => void, rerender: () => void): { recount: () => void; stop: () => void } {
  const tries = new WeakMap<HTMLElement, number>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const layerOf = (el: Element) => (el.closest('[data-ps-layer]') ?? el.closest('[data-ps-bg]')) as HTMLElement | null
  const count = () => {
    let n = 0
    root.querySelectorAll<HTMLElement>('.ps-loading').forEach((el) => el.style.display !== 'none' && n++)
    report(n)
  }
  const onError = (e: Event) => {
    const el = e.target
    if (!(el instanceof HTMLVideoElement || el instanceof HTMLImageElement)) return
    const src = el.getAttribute('src') ?? ''
    if (!src) return // renderer cleared it on removal
    const layer = layerOf(el)
    layer?.classList.add('ps-loading')
    count()
    if (/^(blob|data):/.test(src)) {
      layer?.classList.add('ps-failed')
      return
    }
    const n = (tries.get(el) ?? 0) + 1
    tries.set(el, n)
    if (n > 40) {
      layer?.classList.add('ps-failed')
      return
    }
    const base = src.replace(/([?&])psr=\d+(&|$)/, (_m, a, b) => (b ? a : '')).replace(/[?&]$/, '')
    const t = setTimeout(() => {
      timers.delete(t)
      if (!el.isConnected) return
      el.src = `${base}${base.includes('?') ? '&' : '?'}psr=${n}`
      if (el instanceof HTMLVideoElement) el.load()
    }, Math.min(15000, 1000 * 2 ** Math.min(n - 1, 4)))
    timers.add(t)
  }
  const onLoaded = (e: Event) => {
    const el = e.target
    if (!(el instanceof HTMLVideoElement || el instanceof HTMLImageElement)) return
    tries.delete(el)
    const layer = layerOf(el)
    if (layer?.classList.contains('ps-loading')) {
      layer.classList.remove('ps-loading', 'ps-failed')
      count()
      // redraw so a video lands on the right frame
      rerender()
    }
  }
  root.addEventListener('error', onError, true)
  root.addEventListener('loadeddata', onLoaded, true)
  root.addEventListener('load', onLoaded, true)
  return {
    recount: count,
    stop: () => {
      root.removeEventListener('error', onError, true)
      root.removeEventListener('loadeddata', onLoaded, true)
      root.removeEventListener('load', onLoaded, true)
      for (const t of timers) clearTimeout(t)
    },
  }
}

function useLayerGeo(scale: number): Geo | null {
  const selection = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project)
  // during playback the overlay only dims along: about six updates a second, not a full evaluate every frame
  const playhead = useThrottledPlayhead()
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const measured = useRef<number>(0)
  const id = selection.length === 1 ? selection[0] : null
  const f = id ? findItem(project, id) : null
  const visual = !!f && f.item.type !== 'audio'
  const layer = useMemo(() => (visual ? evaluate(project, playhead).layers.find((l) => l.itemId === id) : undefined), [visual, project, playhead, id])
  let geo: Geo | null = null
  if (f && visual) {
    if (layer) {
      const { rot, sx, sy } = parseTransform(layer.transform)
      let h = layer.box.height
      if (h <= 0) {
        const el = document.querySelector(`.cv-stage [data-ps-layer="${id}"]`) as HTMLElement | null
        h = el?.offsetHeight ?? 0
      }
      geo = { layer, item: f.item, cx: layer.box.cx * scale, cy: layer.box.cy * scale, w: layer.box.width * Math.abs(sx) * scale, h: h * Math.abs(sy) * scale, rot, locked: !editable(f) }
      measured.current = h
    }
  }
  // text heights come from the DOM the renderer just updated; re-measure after paint
  useEffect(() => {
    if (!geo || geo.layer.box.height > 0) return
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(`.cv-stage [data-ps-layer="${geo!.layer.itemId}"]`) as HTMLElement | null
      if (el && Math.abs(el.offsetHeight - measured.current) > 0.5) bump()
    })
    return () => cancelAnimationFrame(raf)
  })
  return geo
}

function SelectionOverlay({ scale, boxRef, beginMove, margin }: { scale: number; boxRef: React.RefObject<HTMLDivElement>; beginMove: (e: React.PointerEvent, id: string) => void; margin: number }) {
  const geo = useLayerGeo(scale)
  const playing = useEditor((s) => s.playing)
  const editing = useEditor((s) => s.editingTextId)
  const [cropping, setCropping] = useState<string | null>(null)
  if (!geo) return null
  const { item } = geo
  const crop = cropping === item.id
  const isText = item.type === 'text'
  const isCaption = item.type === 'caption'
  const center = () => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: r.left + geo.cx, y: r.top + geo.cy }
  }

  const startScale = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const s0 = useEditor.getState()
    const orig = s0.project
    const it = findItem(orig, item.id)?.item
    if (!it || !('transform' in it)) return
    const c = center()
    const d0 = Math.max(4, Math.hypot(e.clientX - c.x, e.clientY - c.y))
    const base = A.readProp(it, 'scale')
    const move = (ev: PointerEvent) => {
      const d = Math.hypot(ev.clientX - c.x, ev.clientY - c.y)
      const v = Math.max(0.05, Math.min(20, (base * d) / d0))
      useEditor.getState().commit(A.writeProp(orig, it.id, 'scale', +v.toFixed(3)), 'Scale', { coalesce: `scale:${it.id}` })
    }
    track(move)
  }

  const startRotate = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const orig = useEditor.getState().project
    const it = findItem(orig, item.id)?.item
    if (!it || !('transform' in it)) return
    const c = center()
    const a0 = Math.atan2(e.clientY - c.y, e.clientX - c.x)
    const base = A.readProp(it, 'rotation')
    const move = (ev: PointerEvent) => {
      const a = Math.atan2(ev.clientY - c.y, ev.clientX - c.x)
      let r = base + ((a - a0) * 180) / Math.PI
      if (ev.shiftKey) r = Math.round(r / 15) * 15
      else {
        const near = Math.round(r / 45) * 45
        if (Math.abs(r - near) < 3) r = near
      }
      useEditor.getState().commit(A.writeProp(orig, it.id, 'rotation', +r.toFixed(2)), 'Rotate', { coalesce: `rot:${it.id}` })
    }
    track(move)
  }

  const startWidth = (e: React.PointerEvent, side: 1 | -1) => {
    e.stopPropagation()
    e.preventDefault()
    const orig = useEditor.getState().project
    const it = findItem(orig, item.id)?.item as TextItem | undefined
    if (!it || it.type !== 'text') return
    const sx = e.clientX
    const sy = e.clientY
    const w0 = it.style.boxWidth
    const rad = (geo.rot * Math.PI) / 180
    const k = scale * A.readProp(it, 'scale')
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      const along = (dx * Math.cos(rad) + dy * Math.sin(rad)) * side
      const w = Math.max(80, Math.round(w0 + (2 * along) / k))
      useEditor.getState().commit(updateItem<TextItem>(orig, it.id, { style: { ...it.style, boxWidth: w } }), 'Text width', { coalesce: `tw:${it.id}` })
    }
    track(move)
  }

  /** Shrink to fit: the top and bottom handles set the box's height (both edges move, the centre stays). */
  const startHeight = (e: React.PointerEvent, side: 1 | -1) => {
    e.stopPropagation()
    e.preventDefault()
    const orig = useEditor.getState().project
    const it = findItem(orig, item.id)?.item as TextItem | undefined
    if (!it || it.type !== 'text' || !it.style.fit) return
    const sx = e.clientX
    const sy = e.clientY
    const h0 = it.style.fit.height
    const rad = (geo.rot * Math.PI) / 180
    const k = scale * A.readProp(it, 'scale')
    track((ev) => {
      const along = (-(ev.clientX - sx) * Math.sin(rad) + (ev.clientY - sy) * Math.cos(rad)) * side
      const h = Math.max(20, Math.round(h0 + (2 * along) / k))
      useEditor.getState().commit(updateItem<TextItem>(orig, it.id, { style: { ...it.style, fit: { height: h } } }), 'Text box height', { coalesce: `th:${it.id}` })
    })
  }

  /** Drag an edge of the picture inwards to crop it (the Crop panel's sliders do the same by keyboard). */
  const startCrop = (e: React.PointerEvent, edge: 'left' | 'right' | 'top' | 'bottom') => {
    e.stopPropagation()
    e.preventDefault()
    const orig = useEditor.getState().project
    const it = findItem(orig, item.id)?.item as VideoItem | ImageItem | undefined
    if (!it || (it.type !== 'video' && it.type !== 'image')) return
    const c0 = it.crop ?? { left: 0, top: 0, right: 0, bottom: 0 }
    const horiz = edge === 'left' || edge === 'right'
    // a flipped picture shows its right edge on the left
    const mirror = horiz ? it.transform.flipX : it.transform.flipY
    const key = mirror ? ({ left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const)[edge] : edge
    const other = ({ left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const)[key]
    const rad = (geo.rot * Math.PI) / 180
    const size = Math.max(4, horiz ? geo.w : geo.h)
    const shown = horiz ? 1 - c0.left - c0.right : 1 - c0.top - c0.bottom
    const sx = e.clientX
    const sy = e.clientY
    track((ev) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      const along = horiz ? dx * Math.cos(rad) + dy * Math.sin(rad) : -dx * Math.sin(rad) + dy * Math.cos(rad)
      const inward = edge === 'left' || edge === 'top' ? along : -along
      const v = Math.max(0, Math.min(0.95 - c0[other], c0[key] + (inward / size) * shown))
      const next = { ...c0, [key]: +v.toFixed(4) }
      const empty = !next.left && !next.top && !next.right && !next.bottom
      useEditor.getState().commit(updateItem<VideoItem>(orig, it.id, { crop: empty ? undefined : next }), 'Crop', { coalesce: `crop:${it.id}` })
    })
  }

  const handles = !playing && !isCaption && !editing && !geo.locked
  return (
    <>
      <div
        className={clsx('cv-sel', isCaption && 'caption', playing && 'dim')}
        style={{ left: geo.cx, top: geo.cy, width: Math.max(8, geo.w), height: Math.max(8, geo.h), transform: `translate(-50%,-50%) rotate(${geo.rot}deg)` }}
      >
        {isCaption && !playing && !geo.locked && (
          <div className="cv-handle cv-body" onPointerDown={(e) => { e.stopPropagation(); beginMove(e, item.id) }} title="Drag to move captions" />
        )}
        {handles && (
          <>
            {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
              <div key={c} className={`cv-handle corner ${c}`} onPointerDown={startScale} />
            ))}
            {isText && (
              <>
                <div className="cv-handle side w" onPointerDown={(e) => startWidth(e, -1)} />
                <div className="cv-handle side e" onPointerDown={(e) => startWidth(e, 1)} />
                {(item as TextItem).style.fit && (
                  <>
                    <div className="cv-handle side n" title="Drag to set the box height" onPointerDown={(e) => startHeight(e, -1)} />
                    <div className="cv-handle side s" title="Drag to set the box height" onPointerDown={(e) => startHeight(e, 1)} />
                  </>
                )}
              </>
            )}
            <div className="cv-rot-stem" />
            <div className="cv-handle rot" onPointerDown={startRotate} title="Rotate (Shift: 15° steps)">
              <RotateCcw size={10} />
            </div>
            {crop &&
              (['top', 'right', 'bottom', 'left'] as const).map((edge) => (
                <div key={edge} className={`cv-handle crop ${edge}`} data-crop={edge} title={`Drag to crop the ${edge} edge`} onPointerDown={(e) => startCrop(e, edge)} />
              ))}
          </>
        )}
      </div>
      {!playing && !editing && !geo.locked && <ObjectToolbar geo={geo} margin={margin} boxH={boxRef.current?.offsetHeight ?? 0} crop={crop} setCrop={(on) => setCropping(on ? item.id : null)} />}
    </>
  )
}

/**
 * Several objects selected: one box around them all. Its corners scale the group about its centre, its handle
 * rotates it (each object turns and orbits the centre), and its toolbar aligns and distributes.
 */
function GroupOverlay({ scale, boxRef, margin }: { scale: number; boxRef: React.RefObject<HTMLDivElement>; margin: number }) {
  const selection = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project)
  const playing = useEditor((s) => s.playing)
  const playhead = useThrottledPlayhead()
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const multi = selection.length > 1
  const boxes = useMemo(() => {
    if (!multi) return []
    const ids = new Set(selection)
    return layerBoxes(project, playhead).filter((b) => ids.has(b.id))
  }, [multi, selection, project, playhead])
  // text heights come from the renderer's DOM: measure again after it has drawn
  useEffect(() => {
    if (!multi) return
    const raf = requestAnimationFrame(() => {
      const ids = new Set(selection)
      const now = layerBoxes(useEditor.getState().project, useEditor.getState().playhead).filter((b) => ids.has(b.id))
      if (now.some((b, i) => Math.abs(b.bottom - b.top - (boxes[i] ? boxes[i].bottom - boxes[i].top : 0)) > 0.5)) bump()
    })
    return () => cancelAnimationFrame(raf)
  })
  const g = union(boxes)
  if (!multi || !g) return null
  const movable = boxes.filter((b) => editable(findItem(project, b.id)) && 'transform' in findItem(project, b.id)!.item)
  const W = project.width
  const H = project.height
  const gcx = (g.left + g.right) / 2
  const gcy = (g.top + g.bottom) / 2
  const screenCentre = () => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: r.left + gcx * scale, y: r.top + gcy * scale }
  }
  /** Each movable object's position, scale and rotation at the playhead when the drag started. */
  const starts = () => {
    const s = useEditor.getState()
    return movable.map((b) => {
      const it = findItem(s.project, b.id)!.item
      return { id: b.id, x: A.readProp(it, 'x', s.playhead), y: A.readProp(it, 'y', s.playhead), scale: A.readProp(it, 'scale', s.playhead), rot: A.readProp(it, 'rotation', s.playhead) }
    })
  }
  // the group's centre relative to the canvas centre (the coordinates item positions use)
  const ox = gcx - W / 2
  const oy = gcy - H / 2
  const startScale = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const s0 = useEditor.getState()
    const orig = s0.project
    const t = s0.playhead
    const from = starts()
    const c = screenCentre()
    const d0 = Math.max(4, Math.hypot(e.clientX - c.x, e.clientY - c.y))
    track((ev) => {
      const k = Math.max(0.05, Math.hypot(ev.clientX - c.x, ev.clientY - c.y) / d0)
      let p = orig
      for (const o of from) {
        p = A.writeProp(p, o.id, 'scale', +Math.max(0.05, Math.min(20, o.scale * k)).toFixed(3), t)
        p = A.writeProp(p, o.id, 'x', Math.round(ox + (o.x - ox) * k), t)
        p = A.writeProp(p, o.id, 'y', Math.round(oy + (o.y - oy) * k), t)
      }
      useEditor.getState().commit(p, 'Scale objects', { coalesce: `gscale:${selection.join(',')}` })
    })
  }
  const startRotate = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const s0 = useEditor.getState()
    const orig = s0.project
    const t = s0.playhead
    const from = starts()
    const c = screenCentre()
    const a0 = Math.atan2(e.clientY - c.y, e.clientX - c.x)
    track((ev) => {
      let deg = ((Math.atan2(ev.clientY - c.y, ev.clientX - c.x) - a0) * 180) / Math.PI
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15
      const r = (deg * Math.PI) / 180
      const cos = Math.cos(r)
      const sin = Math.sin(r)
      let p = orig
      for (const o of from) {
        const vx = o.x - ox
        const vy = o.y - oy
        p = A.writeProp(p, o.id, 'rotation', +(o.rot + deg).toFixed(2), t)
        p = A.writeProp(p, o.id, 'x', Math.round(ox + vx * cos - vy * sin), t)
        p = A.writeProp(p, o.id, 'y', Math.round(oy + vx * sin + vy * cos), t)
      }
      useEditor.getState().commit(p, 'Rotate objects', { coalesce: `grot:${selection.join(',')}` })
    })
  }
  const w = (g.right - g.left) * scale
  const h = (g.bottom - g.top) * scale
  const handles = !playing && movable.length > 0
  const boxH = boxRef.current?.offsetHeight ?? 0
  const below = g.bottom * scale + 12
  const top = below + TOOLBAR_H <= boxH + margin - 4 ? below : Math.max(4 - margin, g.top * scale - 44 - TOOLBAR_H)
  return (
    <>
      <div className={clsx('cv-sel group', playing && 'dim')} data-group-box style={{ left: gcx * scale, top: gcy * scale, width: Math.max(8, w), height: Math.max(8, h), transform: 'translate(-50%,-50%)' }}>
        {boxes.map((b) => (
          <div key={b.id} className="cv-member" style={{ left: (b.left - g.left) * scale, top: (b.top - g.top) * scale, width: (b.right - b.left) * scale, height: (b.bottom - b.top) * scale }} />
        ))}
        {handles && (
          <>
            {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
              <div key={c} className={`cv-handle corner ${c}`} onPointerDown={startScale} title="Scale the selection" />
            ))}
            <div className="cv-rot-stem" />
            <div className="cv-handle rot" onPointerDown={startRotate} title="Rotate the selection (Shift: 15° steps)">
              <RotateCcw size={10} />
            </div>
          </>
        )}
      </div>
      {!playing && movable.length > 0 && (
        <div className="cv-toolbar cv-group-bar" style={{ left: gcx * scale, top }} onPointerDown={(e) => e.stopPropagation()} role="toolbar" aria-label={`${boxes.length} objects selected`}>
          <AlignButtons count={movable.length} className="" size={15} />
          <div className="sep" />
          <button title="Duplicate (Ctrl+D)" aria-label="Duplicate" onClick={A.duplicate}><CopyPlus size={15} /></button>
          <button title="Delete" aria-label="Delete" onClick={() => A.remove()}><Trash2 size={15} /></button>
        </div>
      )}
    </>
  )
}

function track(move: (e: PointerEvent) => void) {
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    useEditor.getState().endCoalesce()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

const TOOLBAR_H = 36

function ObjectToolbar({ geo, margin, boxH, crop, setCrop }: { geo: Geo; margin: number; boxH: number; crop: boolean; setCrop: (on: boolean) => void }) {
  const [more, setMore] = useState(false)
  const item = geo.item
  const commit = useEditor((s) => s.commit)
  const project = useEditor((s) => s.project)
  const isMedia = item.type === 'video' || item.type === 'image'
  const hasTransform = 'transform' in item
  // below the selection if there's room, else above (clear of the rotate handle), else inside the bottom edge
  const below = geo.cy + geo.h / 2 + 12
  const above = geo.cy - geo.h / 2 - 44 - TOOLBAR_H
  const top =
    below + TOOLBAR_H <= boxH + margin - 4 ? below : above >= -margin + 4 ? above : Math.max(4 - margin, Math.min(geo.cy + geo.h / 2 - TOOLBAR_H - 8, boxH + margin - TOOLBAR_H - 4))
  const flip = (axis: 'flipX' | 'flipY') => {
    if (!hasTransform) return
    const v = item as VisualItem
    commit(updateItem<VisualItem>(project, v.id, { transform: { ...v.transform, [axis]: !v.transform[axis] } }), 'Flip')
  }
  if (item.type === 'caption') return null
  const media = item as VideoItem | ImageItem
  const c = isMedia ? media.crop ?? { left: 0, top: 0, right: 0, bottom: 0 } : null
  const setCropEdge = (k: 'left' | 'top' | 'right' | 'bottom', v: number) => {
    const s = useEditor.getState()
    const cur = (findItem(s.project, item.id)?.item as VideoItem | undefined)?.crop ?? { left: 0, top: 0, right: 0, bottom: 0 }
    const next = { ...cur, [k]: v }
    const empty = !next.left && !next.top && !next.right && !next.bottom
    s.commit(updateItem<VideoItem>(s.project, item.id, { crop: empty ? undefined : next }), 'Crop', { coalesce: `crop:${item.id}` })
  }
  return (
    <div className="cv-toolbar" style={{ left: geo.cx, top }} onPointerDown={(e) => e.stopPropagation()}>
      <button {...tipProps('Duplicate', undefined, 'Ctrl+D')} onClick={A.duplicate}><CopyPlus size={15} /></button>
      <button {...tipProps('Delete', 'Shift+Del also closes the gap it leaves.', 'Del')} onClick={() => A.remove()}><Trash2 size={15} /></button>
      {hasTransform && <button title="Flip horizontal" onClick={() => flip('flipX')}><FlipHorizontal2 size={15} /></button>}
      {isMedia && (
        <button title="Crop" aria-pressed={crop} className={clsx(crop && 'on')} onClick={() => setCrop(!crop)}><Crop size={15} /></button>
      )}
      {isMedia && (
        <button
          title={media.fit === 'cover' ? 'Fit (letterbox)' : 'Fill (crop to frame)'}
          className="txt"
          onClick={() => commit(updateItem<VideoItem>(project, item.id, { fit: media.fit === 'cover' ? 'contain' : 'cover' }), media.fit === 'cover' ? 'Fit' : 'Fill')}
        >
          {media.fit === 'cover' ? <Minimize size={14} /> : <Maximize size={14} />}
          {media.fit === 'cover' ? 'Fit' : 'Fill'}
        </button>
      )}
      {item.type === 'text' && (
        <button className="txt" {...tipProps('Edit text', 'Or double-click the text on the canvas.')} onClick={() => useEditor.setState({ editingTextId: item.id })}>Edit</button>
      )}
      <div className="sep" />
      <button title="More" onClick={() => setMore(!more)}><MoreHorizontal size={15} /></button>
      <Menu open={more} onClose={() => setMore(false)} className="cv-more">
        <MenuItem icon={<Copy size={14} />} label="Copy" kbd="Ctrl C" onClick={() => { A.copy(); setMore(false) }} />
        <MenuItem icon={<Scissors size={14} />} label="Cut" kbd="Ctrl X" onClick={() => { A.cut(); setMore(false) }} />
        <MenuItem icon={<ClipboardPaste size={14} />} label="Paste" kbd="Ctrl V" onClick={() => { A.paste(); setMore(false) }} />
        {hasTransform && <MenuItem icon={<FlipVertical2 size={14} />} label="Flip vertical" onClick={() => { flip('flipY'); setMore(false) }} />}
        {hasTransform && (
          <MenuItem
            icon={<RotateCcw size={14} />}
            label="Reset transform"
            onClick={() => {
              commit(resetTransform(project, item.id), 'Reset transform')
              setMore(false)
            }}
          />
        )}
      </Menu>
      {crop && c && (
        <div className="cv-crop ed-menu" onPointerDown={(e) => e.stopPropagation()}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Crop</div>
          {(['left', 'right', 'top', 'bottom'] as const).map((k) => (
            <Slider key={k} label={k[0].toUpperCase() + k.slice(1)} value={c[k]} min={0} max={0.45} step={0.005} onChange={(v) => setCropEdge(k, v)} display={{ to: (v) => v * 100, from: (v) => v / 100, step: 1 }} suffix="%" />
          ))}
          <button className="btn sm" style={{ width: '100%', marginTop: 6 }} onClick={() => commit(updateItem<VideoItem>(project, item.id, { crop: undefined }), 'Reset crop')}>Reset crop</button>
        </div>
      )}
    </div>
  )
}

function InlineTextEditor({ id }: { id: string }) {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const ref = useRef<HTMLTextAreaElement>(null)
  const f = findItem(project, id)
  const it = f?.item.type === 'text' ? (f.item as TextItem) : null
  const [text, setText] = useState(it?.text ?? '')
  const layer = it ? evaluate(project, playhead).layers.find((l) => l.itemId === id) : undefined
  const style = it?.style

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !style) return
    el.setAttribute(
      'style',
      textCss(style) +
        `;text-transform:${style.uppercase ? 'uppercase' : 'none'};background:transparent;border:0;outline:none;resize:none;overflow:hidden;width:100%;padding:0;margin:0;display:block;caret-color:#35e0ff`,
    )
    el.focus()
    el.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  })

  const done = (save: boolean) => {
    const s = useEditor.getState()
    if (save && it && text !== it.text) s.commit(setTextContent(s.project, id, text), 'Edit text')
    s.set({ editingTextId: null })
  }

  if (!it || !layer) {
    return null
  }
  return (
    <>
      <style>{`.cv-stage [data-ps-layer="${id}"]{opacity:0 !important}`}</style>
      <div
        className="cv-textedit"
        style={{ left: layer.box.cx, top: layer.box.cy, width: layer.box.width, transform: `translate(-50%,-50%) ${layer.transform}` }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <textarea
          ref={ref}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => done(true)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') done(false)
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(true)
          }}
        />
      </div>
    </>
  )
}


