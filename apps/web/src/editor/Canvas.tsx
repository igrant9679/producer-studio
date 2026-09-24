// Centre canvas: StageRenderer preview + selection overlay (move / scale / rotate / text width), centre-line
// snapping, inline text editing, floating object toolbar, hand/zoom, drop target for media.
import type { FrameLayer, ImageItem, Item, TextItem, VideoItem, VisualItem } from '@producer/core'
import { StageRenderer, evaluate, findItem, textCss, updateItem, updateTrack } from '@producer/core'
import clsx from 'clsx'
import { Copy, Crop, FlipHorizontal2, FlipVertical2, Loader2, Maximize, Minimize, MoreHorizontal, RotateCcw, Scissors, ClipboardPaste, Trash2, CopyPlus } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import * as A from './actions'
import { Menu, MenuItem, Slider } from './controls'
import { dragPayload, isInternalDrag, makeResolver } from './media'
import { useEditor } from './store'

const TRANSFORM_RE = /rotate\(([-\d.e]+)deg\) scale\(([-\d.e]+), ([-\d.e]+)\)/

function parseTransform(t: string) {
  const m = t.match(TRANSFORM_RE)
  return m ? { rot: +m[1], sx: +m[2], sy: +m[3] } : { rot: 0, sx: 1, sy: 1 }
}

interface Geo {
  layer: FrameLayer
  item: Item
  cx: number
  cy: number
  w: number
  h: number
  rot: number
}

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
  const [avail, setAvail] = useState({ w: 800, h: 450 })
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })
  const [dropping, setDropping] = useState(false)
  const [loadingMedia, setLoadingMedia] = useState(0)

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
    const r = new StageRenderer(root, st.project, {
      mode: 'preview',
      resolveUrl: makeResolver(() => useEditor.getState().project),
      onBuffering: (b) => useEditor.setState({ buffering: b }),
    })
    r.render(st.playhead)
    let disposed = false
    const media = watchMediaLoading(root, setLoadingMedia, () => !disposed && r.render(useEditor.getState().playhead))
    const unsub = useEditor.subscribe((s, prev) => {
      const pc = s.project !== prev.project
      if (pc) r.setProject(s.project)
      if (s.playing !== prev.playing) r.setPlaying(s.playing)
      if (pc || s.playhead !== prev.playhead || s.playing !== prev.playing) {
        r.render(s.playhead)
        media.recount()
      }
    })
    // re-render once fonts are ready so text measures correctly
    void document.fonts?.ready.then(() => !disposed && r.render(useEditor.getState().playhead))
    return () => {
      disposed = true
      media.stop()
      unsub()
      r.destroy()
    }
  }, [])

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
    if (e.button === 1 || tool === 'hand') {
      startPan(e)
      return
    }
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.cv-handle, .cv-toolbar, .cv-textedit, .ed-menu')) return
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
    if (!s.selection.includes(id) || s.selection.length > 1) s.select([id])
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

  /** Drag an item's position (or a caption track's vertical position). */
  const beginMove = (e: React.PointerEvent, id: string) => {
    const s0 = useEditor.getState()
    const f = findItem(s0.project, id)
    if (!f || f.track.locked || f.item.locked) return
    const orig = s0.project
    const it = f.item
    const sx = e.clientX
    const sy = e.clientY
    const ox = it.type === 'caption' ? 0 : A.readProp(it, 'x')
    const oy = it.type === 'caption' ? (f.track.captionStyle?.position ?? 0.86) * H : A.readProp(it, 'y')
    const sc = scale
    let moved = false
    const move = (ev: PointerEvent) => {
      let dx = (ev.clientX - sx) / sc
      let dy = (ev.clientY - sy) / sc
      if (!moved && Math.hypot(dx * sc, dy * sc) < 3) return
      moved = true
      if (ev.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }
      const s = useEditor.getState()
      if (it.type === 'caption') {
        const pos = Math.max(0.05, Math.min(0.95, (oy + dy) / H))
        const cs = f.track.captionStyle
        if (cs) s.commit(updateTrack(orig, f.track.id, { captionStyle: { ...cs, position: +pos.toFixed(4) } }), 'Move captions', { coalesce: `cmove:${f.track.id}` })
        return
      }
      let nx = ox + dx
      let ny = oy + dy
      const th = 8 / sc
      const v = Math.abs(nx) < th
      const h = Math.abs(ny) < th
      if (v) nx = 0
      if (h) ny = 0
      setGuides({ v, h })
      let p = A.writeProp(orig, id, 'x', Math.round(nx), s.playhead)
      p = A.writeProp(p, id, 'y', Math.round(ny), s.playhead)
      s.commit(p, 'Move', { coalesce: `move:${id}` })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setGuides({ v: false, h: false })
      useEditor.getState().endCoalesce()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const id = hitTest(e.clientX, e.clientY)
    if (!id) return
    const f = findItem(useEditor.getState().project, id)
    if (f?.item.type === 'text') useEditor.setState({ selection: [id], editingTextId: id, playing: false })
    if (f?.item.type === 'caption') useEditor.setState({ selection: [id], activeRightTab: 'caption' })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.key.startsWith('Arrow') || e.ctrlKey || e.metaKey || e.altKey) return
    if ((e.target as HTMLElement).closest('input, textarea')) return
    const s = useEditor.getState()
    const f = s.selection.length === 1 ? findItem(s.project, s.selection[0]) : null
    if (!f || !('transform' in f.item)) return
    e.preventDefault()
    e.stopPropagation()
    const d = e.shiftKey ? 10 : 1
    const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0
    const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0
    let p = s.project
    if (dx) p = A.writeProp(p, f.item.id, 'x', A.readProp(f.item, 'x') + dx)
    if (dy) p = A.writeProp(p, f.item.id, 'y', A.readProp(f.item, 'y') + dy)
    s.commit(p, 'Nudge', { coalesce: `nudge:${f.item.id}` })
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
        {guides.v && <div className="cv-guide v" />}
        {guides.h && <div className="cv-guide h" />}
        {!fullscreen && <SelectionOverlay scale={scale} boxRef={boxRef} beginMove={beginMove} margin={Math.max(0, (avail.h - H * scale) / 2 + pan.y)} />}
      </div>
      {(buffering || loadingMedia > 0) && (
        <div className="cv-buffering">
          <Loader2 size={14} className="spin" /> {loadingMedia > 0 ? `Loading media${loadingMedia > 1 ? ` (${loadingMedia})` : ''}…` : 'Buffering'}
        </div>
      )}
      {fullscreen && (
        <button className="btn sm cv-exit-fs" onClick={() => useEditor.setState({ fullscreen: false })}>
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
  const playhead = useEditor((s) => s.playhead)
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const measured = useRef<number>(0)
  const id = selection.length === 1 ? selection[0] : null
  const f = id ? findItem(project, id) : null
  let geo: Geo | null = null
  if (f && f.item.type !== 'audio') {
    const layer = evaluate(project, playhead).layers.find((l) => l.itemId === id)
    if (layer) {
      const { rot, sx, sy } = parseTransform(layer.transform)
      let h = layer.box.height
      if (h <= 0) {
        const el = document.querySelector(`.cv-stage [data-ps-layer="${id}"]`) as HTMLElement | null
        h = el?.offsetHeight ?? 0
      }
      geo = { layer, item: f.item, cx: layer.box.cx * scale, cy: layer.box.cy * scale, w: layer.box.width * Math.abs(sx) * scale, h: h * Math.abs(sy) * scale, rot }
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
  if (!geo) return null
  const { item } = geo
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

  const handles = !playing && !isCaption && !editing
  return (
    <>
      <div
        className={clsx('cv-sel', isCaption && 'caption', playing && 'dim')}
        style={{ left: geo.cx, top: geo.cy, width: Math.max(8, geo.w), height: Math.max(8, geo.h), transform: `translate(-50%,-50%) rotate(${geo.rot}deg)` }}
      >
        {isCaption && !playing && (
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
              </>
            )}
            <div className="cv-rot-stem" />
            <div className="cv-handle rot" onPointerDown={startRotate} title="Rotate (Shift: 15° steps)">
              <RotateCcw size={10} />
            </div>
          </>
        )}
      </div>
      {!playing && !editing && <ObjectToolbar geo={geo} margin={margin} boxH={boxRef.current?.offsetHeight ?? 0} />}
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

function ObjectToolbar({ geo, margin, boxH }: { geo: Geo; margin: number; boxH: number }) {
  const [more, setMore] = useState(false)
  const [crop, setCrop] = useState(false)
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
      <button title="Duplicate (Ctrl+D)" onClick={A.duplicate}><CopyPlus size={15} /></button>
      <button title="Delete" onClick={() => A.remove()}><Trash2 size={15} /></button>
      {hasTransform && <button title="Flip horizontal" onClick={() => flip('flipX')}><FlipHorizontal2 size={15} /></button>}
      {isMedia && (
        <button title="Crop" className={clsx(crop && 'on')} onClick={() => setCrop(!crop)}><Crop size={15} /></button>
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
        <button className="txt" title="Edit text (double-click)" onClick={() => useEditor.setState({ editingTextId: item.id })}>Edit</button>
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
              const v = item as VisualItem
              commit(updateItem<VisualItem>(project, v.id, { transform: { x: 0, y: 0, scale: 1, rotation: 0 }, keyframes: { ...v.keyframes, x: undefined, y: undefined, scale: undefined, rotation: undefined } }), 'Reset transform')
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
    if (save && it && text !== it.text) s.commit(updateItem<TextItem>(s.project, id, { text, name: text.split('\n')[0].slice(0, 40) || 'Text' }), 'Edit text')
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


