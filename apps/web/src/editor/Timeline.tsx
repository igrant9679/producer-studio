// Multi-track timeline: toolbar, adaptive ruler, track headers, clips (filmstrip / waveform / label), selection
// (click, ctrl/shift, marquee), move across tracks (gap drop creates a track), trim, snapping with a guide line,
// playhead scrub, keyframe diamonds, transition markers, context menu and drops from the asset panels.
import type { Asset, Item, Project, Track, TransitionType, VideoItem, VisualItem } from '@producer/core'
import {

  FILTERS,
  TRANSITIONS,
  acceptsItem,
  clone,
  findItem,
  insertTrack,
  itemEnd,
  moveItem,
  projectDuration,
  snapPoints,
  trimItem,
  uid,
  updateItem,
  updateTrack,

} from '@producer/core'
import clsx from 'clsx'
import {
  ArrowLeftRight,
  AudioLines,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  FileText,
  Film,
  Image as ImageIcon,
  Lock,
  Magnet,
  Maximize2,
  Music,
  Pause,
  Play,
  Scissors,
  SkipBack,
  SkipForward,
  Snowflake,
  SplitSquareHorizontal,
  Subtitles,
  Trash2,
  Type,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
  Layers,
  Shapes,
  Diamond,
  X,
} from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as A from './actions'
import { Menu, MenuItem, Slider } from './controls'
import { dragPayload, filmstripUrl, isInternalDrag, thumbUrl } from './media'
import { useAppearance } from '../lib/appearance'
import { useEditor } from './store'
import {
  HEADER_W,
  RULER_H,
  type Row,
  dropTargetAt,
  fitZoom,
  gapToAboveIndex,
  layoutRows,
  marqueeHits,
  rulerLabel,
  shortDuration,
  sliderToZoom,
  snapAt,
  snapSpan,
  tickStep,
  timecode,
  zoomToSlider,
  type DropTarget,
} from './timelineMath'

/** Appearance density, read at event time so pointer maths matches the rendered rows. */
const isCompact = () => useAppearance.getState().prefs.density === 'compact'

const TL_KEY = 'ps.editor.timelineHeight'

interface MoveDrag {
  ids: string[]
  primary: string
  dt: number
  target: DropTarget | null
  snapAt?: number
}

interface Ctx {
  x: number
  y: number
  itemId?: string
  time: number
}

interface TransPop {
  itemId: string
  x: number
  y: number
}

export function kindColor(track: Track | undefined, item?: Item): string {
  if (item?.type === 'audio') return 'var(--track-audio)'
  if (item?.type === 'caption') return 'var(--track-caption)'
  if (item?.type === 'text' || item?.type === 'shape') return 'var(--track-text)'
  if (!track) return 'var(--track-video)'
  if (track.kind === 'overlay') return 'var(--track-overlay)'
  if (track.kind === 'text') return 'var(--track-text)'
  if (track.kind === 'audio') return 'var(--track-audio)'
  if (track.kind === 'caption') return 'var(--track-caption)'
  return 'var(--track-video)'
}

function kindForItem(type: Item['type']): Track['kind'] | null {
  if (type === 'audio') return 'audio'
  if (type === 'caption') return null
  if (type === 'text' || type === 'shape') return 'text'
  return 'overlay'
}

export function Timeline() {
  const [height, setHeight] = useState(() => {
    try {
      return Math.max(180, Math.min(700, Number(localStorage.getItem(TL_KEY)) || 300))
    } catch {
      return 300
    }
  })
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const sy = e.clientY
    const h0 = height
    const move = (ev: PointerEvent) => setHeight(Math.max(160, Math.min(window.innerHeight - 260, h0 - (ev.clientY - sy))))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setHeight((h) => {
        try {
          localStorage.setItem(TL_KEY, String(Math.round(h)))
        } catch {
          /* ignore */
        }
        return h
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className="tl" style={{ height }}>
      <div className="tl-resize" onPointerDown={startResize} title="Drag to resize" />
      <TimelineBody />
    </div>
  )
}

function TimelineBody() {
  const project = useEditor((s) => s.project)
  const zoom = useEditor((s) => s.zoom)
  const selection = useEditor((s) => s.selection)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const [viewW, setViewW] = useState(900)
  const [drag, setDrag] = useState<MoveDrag | null>(null)
  const [snapLine, setSnapLine] = useState<number | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [trans, setTrans] = useState<TransPop | null>(null)
  const [dropHint, setDropHint] = useState<{ x: number; target: DropTarget; w: number } | null>(null)
  const zoomAnchor = useRef<{ t: number; px: number } | null>(null)

  const compact = useAppearance((s) => s.prefs.density === 'compact')
  const { rows, height: rowsH } = useMemo(() => layoutRows(project, compact), [project, compact])
  const duration = projectDuration(project)
  const contentW = Math.max(viewW - HEADER_W, (duration + 12) * zoom)
  const selSet = useMemo(() => new Set(selection), [selection])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    setViewW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // initial fit
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || !scrollRef.current || duration <= 0) return
    fitted.current = true
    useEditor.getState().setZoom(fitZoom(duration, scrollRef.current.clientWidth - HEADER_W))
  }, [duration])

  // keep the time under the pointer fixed while ctrl+wheel zooming
  useLayoutEffect(() => {
    const a = zoomAnchor.current
    const el = scrollRef.current
    if (!a || !el) return
    el.scrollLeft = Math.max(0, a.t * zoom - a.px)
    zoomAnchor.current = null
  }, [zoom])

  // playback follow: page the view when the playhead leaves it
  useEffect(() => {
    return useEditor.subscribe((s, prev) => {
      if (!s.playing || s.playhead === prev.playhead) return
      const el = scrollRef.current
      if (!el) return
      const x = s.playhead * s.zoom
      const visW = el.clientWidth - HEADER_W
      if (x > el.scrollLeft + visW - 30 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 60)
    })
  }, [])

  const toContent = useCallback((clientX: number, clientY: number) => {
    const r = rowsRef.current!.getBoundingClientRect()
    return { x: clientX - r.left - HEADER_W, y: clientY - r.top }
  }, [])

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    const el = scrollRef.current!
    const { x } = toContent(e.clientX, e.clientY)
    const t = x / zoom
    zoomAnchor.current = { t, px: x - el.scrollLeft }
    useEditor.getState().setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
  }
  useEffect(() => {
    // React's onWheel is passive; block browser zoom on ctrl+wheel over the timeline
    const el = scrollRef.current
    if (!el) return
    const h = (e: WheelEvent) => (e.ctrlKey || e.metaKey) && e.preventDefault()
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [])

  // ---------- seek / scrub ----------
  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const s = useEditor.getState()
    s.setPlaying(false)
    const at = (cx: number) => {
      let t = Math.max(0, toContent(cx, 0).x / useEditor.getState().zoom)
      if (useEditor.getState().snapping) {
        const pts = snapPoints(useEditor.getState().project, new Set())
        t = snapAt(t, pts, useEditor.getState().zoom, 5).t
      }
      A.seek(t)
    }
    at(e.clientX)
    const move = (ev: PointerEvent) => at(ev.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---------- marquee / empty click ----------
  const onRowsPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const el = e.target as HTMLElement
    if (el.closest('.tl-clip, .tl-head, .tl-trans')) return
    setCtx(null)
    setTrans(null)
    const s = useEditor.getState()
    const additive = e.ctrlKey || e.metaKey || e.shiftKey
    const base = additive ? s.selection : []
    const start = toContent(e.clientX, e.clientY)
    let active = false
    const move = (ev: PointerEvent) => {
      const p = toContent(ev.clientX, ev.clientY)
      if (!active && Math.hypot(p.x - start.x, p.y - start.y) < 4) return
      active = true
      const rect = { x0: start.x, y0: start.y, x1: p.x, y1: p.y }
      setMarquee(rect)
      const hits = marqueeHits(rect, layoutRows(useEditor.getState().project, isCompact()).rows, useEditor.getState().zoom)
      useEditor.getState().select([...new Set([...base, ...hits])])
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setMarquee(null)
      if (!active) {
        if (!additive) useEditor.getState().select([])
        if (start.x >= 0) {
          useEditor.getState().setPlaying(false)
          A.seek(start.x / useEditor.getState().zoom)
        }
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---------- clip move ----------
  const onClipPointerDown = (e: React.PointerEvent, item: Item, row: Row) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setCtx(null)
    setTrans(null)
    const s = useEditor.getState()
    if (e.ctrlKey || e.metaKey) {
      s.select(s.selection.includes(item.id) ? s.selection.filter((x) => x !== item.id) : [...s.selection, item.id])
      return
    }
    if (e.shiftKey && s.selection.length) {
      // range on the same track from the last selected item
      const last = findItem(s.project, s.selection[s.selection.length - 1])
      if (last && last.track.id === row.track.id) {
        const a = Math.min(last.index, row.track.items.findIndex((i) => i.id === item.id))
        const b = Math.max(last.index, row.track.items.findIndex((i) => i.id === item.id))
        s.select([...new Set([...s.selection, ...row.track.items.slice(a, b + 1).map((i) => i.id)])])
      } else s.select([...new Set([...s.selection, item.id])])
      return
    }
    if (!s.selection.includes(item.id)) s.select([item.id])
    if (row.track.locked || item.locked) return
    const ids = useEditor.getState().selection.filter((id) => {
      const f = findItem(s.project, id)
      return f && !f.track.locked && !f.item.locked
    })
    const orig = s.project
    const starts = new Map(ids.map((id) => [id, findItem(orig, id)!.item.start]))
    const minStart = Math.min(...starts.values())
    const pts = snapPoints(orig, new Set(ids), s.playhead)
    const sx = e.clientX
    let dragging = false
    let last: MoveDrag | null = null
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - sx) < 4 && Math.abs(ev.clientY - e.clientY) < 4) return
      dragging = true
      const z = useEditor.getState().zoom
      let dt = (ev.clientX - sx) / z
      if (minStart + dt < 0) dt = -minStart
      let snapT: number | undefined
      if (useEditor.getState().snapping && !ev.altKey) {
        const r = snapSpan(item.start + dt, item.duration, pts, z)
        if (r.at !== undefined) {
          dt = r.start - item.start
          snapT = r.at
        }
      }
      const { y } = toContent(ev.clientX, ev.clientY)
      const target = ids.length === 1 ? dropTargetAt(y, layoutRows(orig, isCompact()).rows) : null
      last = { ids, primary: item.id, dt, target, snapAt: snapT }
      setDrag(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (!dragging || !last) return
      applyMove(orig, last, starts)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const applyMove = (orig: Project, d: MoveDrag, starts: Map<string, number>) => {
    const s = useEditor.getState()
    let p = orig
    if (d.ids.length === 1 && d.target) {
      const id = d.ids[0]
      const f = findItem(orig, id)!
      const start = Math.max(0, starts.get(id)! + d.dt)
      if (d.target.type === 'gap') {
        const kind = kindForItem(f.item.type)
        if (kind) {
          const p2 = clone(orig)
          const { rows: rs } = layoutRows(orig, isCompact())
          const mainIdx = orig.tracks.findIndex((t) => t.main)
          const t = insertTrack(p2, kind, kind === 'audio' ? undefined : gapToAboveIndex(d.target.gap, rs, mainIdx))
          p = moveItem(p2, id, { start, trackId: t.id })
        } else p = moveItem(orig, id, { start })
      } else {
        const tr = d.target.row.track
        const ok = tr.id !== f.track.id && acceptsItem(tr.kind, f.item.type) && !tr.locked
        p = moveItem(orig, id, { start, trackId: ok ? tr.id : f.track.id })
      }
    } else {
      // multi: shift in time on their own tracks (sorted so linked partners don't double-shift)
      const sorted = [...d.ids].sort((a, b) => (d.dt > 0 ? starts.get(b)! - starts.get(a)! : starts.get(a)! - starts.get(b)!))
      for (const id of sorted) {
        const cur = findItem(p, id)
        if (!cur) continue
        const target = Math.max(0, starts.get(id)! + d.dt)
        if (Math.abs(cur.item.start - target) > 1e-4) p = moveItem(p, id, { start: target })
      }
    }
    s.commit(p, 'Move clip')
  }

  // ---------- trim ----------
  const onTrimDown = (e: React.PointerEvent, item: Item, edge: 'start' | 'end') => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const s = useEditor.getState()
    if (!s.selection.includes(item.id)) s.select([item.id])
    const orig = s.project
    const t0 = edge === 'start' ? item.start : itemEnd(item)
    const pts = snapPoints(orig, new Set([item.id]), s.playhead)
    const sx = e.clientX
    const move = (ev: PointerEvent) => {
      const st = useEditor.getState()
      let t = Math.max(0, t0 + (ev.clientX - sx) / st.zoom)
      let line: number | null = null
      if (st.snapping && !ev.altKey) {
        const r = snapAt(t, pts, st.zoom)
        t = r.t
        if (r.snapped) line = r.t
      }
      setSnapLine(line)
      st.commit(trimItem(orig, item.id, edge, t), 'Trim', { coalesce: `trim:${item.id}:${edge}` })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSnapLine(null)
      useEditor.getState().endCoalesce()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---------- context menu ----------
  const onContextMenu = (e: React.MouseEvent, item?: Item) => {
    e.preventDefault()
    e.stopPropagation()
    const s = useEditor.getState()
    if (item && !s.selection.includes(item.id)) s.select([item.id])
    const { x } = toContent(e.clientX, e.clientY)
    setTrans(null)
    setCtx({ x: e.clientX, y: e.clientY, itemId: item?.id, time: Math.max(0, x / zoom) })
  }

  // ---------- drops from panels ----------
  const onDragOver = (e: React.DragEvent) => {
    const p = dragPayload()
    if (!isInternalDrag(e) || !p || (p.kind !== 'asset' && p.kind !== 'text')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const { x, y } = toContent(e.clientX, e.clientY)
    const target = dropTargetAt(y, rows)
    if (!target) return
    const dur = p.kind === 'asset' ? (p.asset.kind === 'image' ? 4 : p.asset.duration ?? 5) : 3
    setDropHint({ x: Math.max(0, x), target, w: dur * zoom })
  }
  const onDrop = (e: React.DragEvent) => {
    const p = dragPayload()
    const hint = dropHint
    setDropHint(null)
    if (!p || (p.kind !== 'asset' && p.kind !== 'text')) return
    e.preventDefault()
    const { x, y } = toContent(e.clientX, e.clientY)
    const t = Math.max(0, x / zoom)
    const target = hint?.target ?? dropTargetAt(y, rows)
    const s = useEditor.getState()
    if (p.kind === 'text') {
      const trackId = target?.type === 'row' && acceptsItem(target.row.track.kind, 'text') ? target.row.track.id : undefined
      const id = A.addText(p.templateId, t)
      if (trackId) {
        const cur = useEditor.getState().project
        const f = findItem(cur, id)
        if (f && f.track.id !== trackId) useEditor.getState().replaceSilently(moveItem(cur, id, { start: t, trackId }))
      }
      return
    }
    const asset: Asset = p.asset
    const type = asset.kind === 'audio' ? 'audio' : asset.kind
    if (target?.type === 'row' && acceptsItem(target.row.track.kind, type) && !target.row.track.locked) {
      A.addAssetAt(asset, t, { trackId: target.row.track.id })
    } else if (target && asset.kind !== 'audio') {
      // new overlay track at the gap (or directly above a row that can't hold video/images)
      const mainIdx = s.project.tracks.findIndex((tr) => tr.main)
      const above = target.type === 'gap' ? gapToAboveIndex(target.gap, rows, mainIdx) : Math.max(mainIdx, target.row.index)
      A.addAssetAt(asset, t, { overlay: { above } })
    } else A.addAssetAt(asset, t)
  }

  const primaryRowOf = (id: string) => rows.find((r) => r.track.items.some((i) => i.id === id))

  return (
    <>
      <TimelineToolbar viewW={viewW} />
      <div className="tl-scroll" ref={scrollRef} onWheel={onWheel}>
        <div className="tl-inner" style={{ width: HEADER_W + contentW }}>
          <div className="tl-ruler-row" style={{ height: RULER_H }}>
            <div className="tl-corner">
              <span className="eyebrow">Tracks</span>
              <span className="muted" style={{ fontSize: '0.6875rem' }}>{project.tracks.length}</span>
            </div>
            <Ruler width={contentW} zoom={zoom} fps={project.fps} duration={duration} onPointerDown={startScrub} />
          </div>
          <div
            className="tl-rows"
            ref={rowsRef}
            style={{ height: rowsH + 64 }}
            onPointerDown={onRowsPointerDown}
            onContextMenu={(e) => onContextMenu(e)}
            onDragOver={onDragOver}
            onDragLeave={() => setDropHint(null)}
            onDrop={onDrop}
          >
            {rows.map((row) => (
              <TrackRow
                key={row.track.id}
                row={row}
                zoom={zoom}
                contentW={contentW}
                selSet={selSet}
                drag={drag}
                onClipPointerDown={onClipPointerDown}
                onTrimDown={onTrimDown}
                onContextMenu={onContextMenu}
                onTransition={(itemId, x, y) => {
                  setCtx(null)
                  setTrans({ itemId, x, y })
                }}
              />
            ))}
            {!project.tracks.some((t) => t.items.length) && (
              <div className="tl-empty" style={{ left: HEADER_W + 24, top: rows[0] ? rows[0].top + 18 : 18 }}>
                Drag media here, or press <b>+</b> on a clip in the Media panel
              </div>
            )}
            <div className="tl-overlay" style={{ left: HEADER_W, width: contentW }}>
              {drag && <DragGhosts drag={drag} rows={rows} zoom={zoom} primaryRowOf={primaryRowOf} />}
              {drag?.snapAt !== undefined && <div className="tl-snap" style={{ left: drag.snapAt * zoom }} />}
              {snapLine !== null && <div className="tl-snap" style={{ left: snapLine * zoom }} />}
              {marquee && (
                <div
                  className="tl-marquee"
                  style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
                />
              )}
              {dropHint && (
                dropHint.target.type === 'gap' ? (
                  <div className="tl-gapline" style={{ top: dropHint.target.y - 1, left: dropHint.x, width: dropHint.w }} />
                ) : (
                  <div className="tl-ghost drop" style={{ left: dropHint.x, top: dropHint.target.row.top, width: dropHint.w, height: dropHint.target.row.height }} />
                )
              )}
              <PlayheadLine />
            </div>
          </div>
        </div>
      </div>
      {ctx && <ContextMenu ctx={ctx} onClose={() => setCtx(null)} onTransition={(itemId) => setTrans({ itemId, x: ctx.x, y: ctx.y })} />}
      {trans && <TransitionPopover pop={trans} onClose={() => setTrans(null)} />}
    </>
  )
}

function DragGhosts({ drag, rows, zoom, primaryRowOf }: { drag: MoveDrag; rows: Row[]; zoom: number; primaryRowOf: (id: string) => Row | undefined }) {
  const project = useEditor((s) => s.project)
  return (
    <>
      {drag.ids.map((id) => {
        const f = findItem(project, id)
        const row = primaryRowOf(id)
        if (!f || !row) return null
        let top = row.top
        let h = row.height
        let gap = false
        if (id === drag.primary && drag.target) {
          if (drag.target.type === 'row') {
            const tr = drag.target.row.track
            if (acceptsItem(tr.kind, f.item.type) && !tr.locked) {
              top = drag.target.row.top
              h = drag.target.row.height
            }
          } else if (kindForItem(f.item.type)) {
            gap = true
            top = drag.target.y - 12
            h = 24
          }
        }
        const left = Math.max(0, f.item.start + drag.dt) * zoom
        return (
          <div key={id}>
            {gap && <div className="tl-gapline" style={{ top: drag.target!.type === 'gap' ? drag.target!.y - 1 : 0, left, width: f.item.duration * zoom }} />}
            <div className={clsx('tl-ghost', gap && 'gap')} style={{ left, top, width: f.item.duration * zoom, height: h }}>
              <span>{f.item.name ?? f.item.type}</span>
            </div>
          </div>
        )
      })}
    </>
  )
}

// ---------- toolbar ----------

function TimelineToolbar({ viewW }: { viewW: number }) {
  const playing = useEditor((s) => s.playing)
  const snapping = useEditor((s) => s.snapping)
  const zoom = useEditor((s) => s.zoom)
  const selection = useEditor((s) => s.selection)
  const fps = useEditor((s) => s.project.fps)
  const project = useEditor((s) => s.project)
  const duration = projectDuration(project)
  const sel = A.selectedItems(project, selection)
  const hasVideo = sel.some((i) => i.type === 'video')
  return (
    <div className="tl-toolbar">
      <div className="row tl-tools">
        <ToolBtn icon={<Scissors size={15} />} title="Split at playhead (Ctrl+B)" onClick={A.split} />
        <ToolBtn icon={<Trash2 size={15} />} title="Delete (Del) · Ripple delete (Shift+Del)" onClick={() => A.remove()} disabled={!selection.length} />
        <ToolBtn icon={<Snowflake size={15} />} title="Freeze frame (2 s)" onClick={A.freeze} />
        <ToolBtn icon={<CopyPlus size={15} />} title="Duplicate (Ctrl+D)" onClick={A.duplicate} disabled={!selection.length} />
        <ToolBtn icon={<SplitSquareHorizontal size={15} />} title="Separate audio" onClick={A.separate} disabled={!hasVideo} />
        <div className="tl-sep" />
        <ToolBtn icon={<Magnet size={15} />} title={`Snapping ${snapping ? 'on' : 'off'} (S)`} active={snapping} onClick={() => useEditor.setState({ snapping: !snapping })} />
      </div>
      <div className="row tl-transport">
        <ToolBtn icon={<SkipBack size={15} />} title="Go to start (Home)" onClick={() => A.seek(0)} />
        <button className="tl-play" title="Play / pause (Space)" onClick={A.togglePlay}>
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <ToolBtn icon={<SkipForward size={15} />} title="Go to end (End)" onClick={() => A.seek(duration)} />
        <div className="tl-tc">
          <Timecode fps={fps} />
          <span className="sep">/</span>
          <span className="total">{timecode(duration, fps)}</span>
        </div>
      </div>
      <div className="row tl-zoom">
        <ToolBtn icon={<ZoomOut size={15} />} title="Zoom out (Ctrl+-)" onClick={() => useEditor.getState().setZoom(zoom / 1.4)} />
        <input
          type="range"
          className="ed-range"
          min={0}
          max={1}
          step={0.001}
          value={zoomToSlider(zoom)}
          style={{ width: 110, ['--pct' as string]: `${zoomToSlider(zoom) * 100}%` }}
          onChange={(e) => useEditor.getState().setZoom(sliderToZoom(parseFloat(e.target.value)))}
          title="Timeline zoom"
        />
        <ToolBtn icon={<ZoomIn size={15} />} title="Zoom in (Ctrl+=)" onClick={() => useEditor.getState().setZoom(zoom * 1.4)} />
        <ToolBtn icon={<Maximize2 size={14} />} title="Fit timeline" onClick={() => useEditor.getState().setZoom(fitZoom(duration, viewW - HEADER_W))} />
      </div>
    </div>
  )
}

function ToolBtn({ icon, title, onClick, disabled, active }: { icon: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button className={clsx('tl-btn', active && 'on')} title={title} onClick={onClick} disabled={disabled}>
      {icon}
    </button>
  )
}

function Timecode({ fps }: { fps: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const set = (t: number) => ref.current && (ref.current.textContent = timecode(t, fps))
    set(useEditor.getState().playhead)
    return useEditor.subscribe((s, prev) => s.playhead !== prev.playhead && set(s.playhead))
  }, [fps])
  return <span ref={ref} className="cur" />
}

// ---------- ruler + playhead ----------

const Ruler = memo(function Ruler({ width, zoom, fps, duration, onPointerDown }: { width: number; zoom: number; fps: number; duration: number; onPointerDown: (e: React.PointerEvent) => void }) {
  const { major, minor } = tickStep(zoom, 76, fps)
  const labels: number[] = []
  const n = Math.ceil(width / zoom / major)
  for (let i = 0; i <= n && i < 2000; i++) labels.push(i * major)
  return (
    <div
      className="tl-ruler"
      style={{
        width,
        backgroundImage: `linear-gradient(90deg, var(--ruler-major) 1px, transparent 1px), linear-gradient(90deg, var(--ruler-minor) 1px, transparent 1px)`,
        backgroundSize: `${major * zoom}px 12px, ${minor * zoom}px 6px`,
        backgroundPosition: '0 100%, 0 100%',
      }}
      onPointerDown={onPointerDown}
    >
      <div className="tl-ruler-end" style={{ left: duration * zoom }} title="End of project" />
      {labels.map((t) => (
        <span key={t} className="tl-tick" style={{ left: t * zoom }}>
          {rulerLabel(t, major, fps)}
        </span>
      ))}
      <PlayheadHead onPointerDown={onPointerDown} />
    </div>
  )
})

function usePlayheadX(ref: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    const set = (s: { playhead: number; zoom: number }) => {
      if (ref.current) ref.current.style.transform = `translateX(${s.playhead * s.zoom}px)`
    }
    set(useEditor.getState())
    return useEditor.subscribe((s, prev) => (s.playhead !== prev.playhead || s.zoom !== prev.zoom) && set(s))
  }, [ref])
}

function PlayheadHead({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  usePlayheadX(ref)
  return (
    <div ref={ref} className="tl-ph-head" onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e) }}>
      <svg width="13" height="16" viewBox="0 0 13 16"><path d="M1 1h11v9l-5.5 5L1 10z" /></svg>
    </div>
  )
}

function PlayheadLine() {
  const ref = useRef<HTMLDivElement>(null)
  usePlayheadX(ref)
  return <div ref={ref} className="tl-ph-line" />
}

// ---------- tracks & clips ----------

interface TrackRowProps {
  row: Row
  zoom: number
  contentW: number
  selSet: Set<string>
  drag: MoveDrag | null
  onClipPointerDown: (e: React.PointerEvent, item: Item, row: Row) => void
  onTrimDown: (e: React.PointerEvent, item: Item, edge: 'start' | 'end') => void
  onContextMenu: (e: React.MouseEvent, item?: Item) => void
  onTransition: (itemId: string, x: number, y: number) => void
}

function TrackRow({ row, zoom, contentW, selSet, drag, onClipPointerDown, onTrimDown, onContextMenu, onTransition }: TrackRowProps) {
  const t = row.track
  const project = useEditor((s) => s.project)
  const visual = t.kind === 'video' || t.kind === 'overlay'
  return (
    <div className={clsx('tl-row', t.main && 'main', t.locked && 'locked', t.hidden && 'hidden')} style={{ top: row.top, height: row.height }}>
      <TrackHeader track={t} />
      <div className="tl-lane" style={{ width: contentW }}>
        {t.items.map((it, i) => {
          const next = t.items[i + 1]
          const adjacent = visual && next && Math.abs(next.start - itemEnd(it)) < 0.05 && it.type !== 'audio' && it.type !== 'caption'
          return (
            <ClipView
              key={it.id}
              item={it}
              track={t}
              project={project}
              zoom={zoom}
              height={row.height}
              selected={selSet.has(it.id)}
              dragging={!!drag?.ids.includes(it.id)}
              onPointerDown={(e) => onClipPointerDown(e, it, row)}
              onTrimDown={(e, edge) => onTrimDown(e, it, edge)}
              onContextMenu={(e) => onContextMenu(e, it)}
              cut={adjacent ? (e: React.MouseEvent) => onTransition(it.id, e.clientX, e.clientY) : undefined}
            />
          )
        })}
      </div>
    </div>
  )
}

function TrackIcon({ track }: { track: Track }) {
  const s = 14
  if (track.kind === 'audio') return <Music size={s} />
  if (track.kind === 'caption') return <Subtitles size={s} />
  if (track.kind === 'text') return <Type size={s} />
  if (track.kind === 'overlay') return <Layers size={s} />
  return <Film size={s} />
}

function TrackHeader({ track }: { track: Track }) {
  const project = useEditor((s) => s.project)
  const commit = useEditor((s) => s.commit)
  const [editing, setEditing] = useState(false)
  const up = (patch: Partial<Track>, label: string) => commit(updateTrack(project, track.id, patch), label)
  const visual = track.kind !== 'audio'
  const audible = track.kind === 'audio' || track.kind === 'video' || track.kind === 'overlay'
  return (
    <div className="tl-head" onPointerDown={(e) => e.stopPropagation()}>
      <span className="tl-kind" style={{ color: kindColor(track) }}>
        <TrackIcon track={track} />
      </span>
      {editing ? (
        <input
          className="tl-name-input"
          autoFocus
          defaultValue={track.name}
          onBlur={(e) => {
            setEditing(false)
            if (e.target.value.trim() && e.target.value !== track.name) up({ name: e.target.value.trim() }, 'Rename track')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span className="tl-name" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
          <span className="nm">{track.name}</span>
          {track.main && <em>Main</em>}
        </span>
      )}
      <div className="tl-head-btns">
        {visual && (
          <button title={track.hidden ? 'Show track' : 'Hide track'} className={clsx(track.hidden && 'off')} onClick={() => up({ hidden: !track.hidden }, track.hidden ? 'Show track' : 'Hide track')}>
            {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
        {audible && (
          <button title={track.muted ? 'Unmute track' : 'Mute track'} className={clsx(track.muted && 'off')} onClick={() => up({ muted: !track.muted }, track.muted ? 'Unmute track' : 'Mute track')}>
            {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
        )}
        <button title={track.locked ? 'Unlock track' : 'Lock track'} className={clsx(track.locked && 'off')} onClick={() => up({ locked: !track.locked }, track.locked ? 'Unlock track' : 'Lock track')}>
          {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
        </button>
        {!track.main && (
          <button
            title="Delete track"
            onClick={() => {
              const p = structuredClone(project)
              p.tracks = p.tracks.filter((t) => t.id !== track.id)
              commit(p, 'Delete track')
            }}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

interface ClipProps {
  item: Item
  track: Track
  project: Project
  zoom: number
  height: number
  selected: boolean
  dragging: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onTrimDown: (e: React.PointerEvent, edge: 'start' | 'end') => void
  onContextMenu: (e: React.MouseEvent) => void
  cut?: (e: React.MouseEvent) => void
}

const ClipView = memo(function ClipView({ item, track, project, zoom, height, selected, dragging, onPointerDown, onTrimDown, onContextMenu, cut }: ClipProps) {
  const left = item.start * zoom
  const width = Math.max(2, item.duration * zoom)
  const asset = 'assetId' in item ? project.assets[item.assetId] : undefined
  const color = kindColor(track, item)
  const [dropOn, setDropOn] = useState(false)
  const label =
    item.type === 'text' ? item.text : item.type === 'caption' ? item.text : item.name ?? asset?.name ?? item.type
  const Icon = item.type === 'video' ? Film : item.type === 'image' ? ImageIcon : item.type === 'audio' ? AudioLines : item.type === 'text' ? Type : item.type === 'shape' ? Shapes : Subtitles
  const kfTimes = useMemo(() => {
    if (!('keyframes' in item) || !item.keyframes) return []
    const s = new Set<number>()
    for (const list of Object.values(item.keyframes)) for (const k of list ?? []) s.add(Math.round(k.t * 1000) / 1000)
    return [...s].sort((a, b) => a - b)
  }, [item])
  const tr = 'transitionOut' in item ? item.transitionOut : undefined
  const muted = (item.type === 'video' || item.type === 'audio') && item.muted
  const speed = (item.type === 'video' || item.type === 'audio') && item.speed !== 1 ? item.speed : null

  const onDragOver = (e: React.DragEvent) => {
    const p = dragPayload()
    if (!p || !isInternalDrag(e)) return
    const visual = item.type === 'video' || item.type === 'image' || item.type === 'text' || item.type === 'shape'
    if ((p.kind === 'effect' && visual) || (p.kind === 'filter' && (item.type === 'video' || item.type === 'image')) || (p.kind === 'transition' && visual)) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setDropOn(true)
    }
  }
  const onDrop = (e: React.DragEvent) => {
    setDropOn(false)
    const p = dragPayload()
    if (!p) return
    e.preventDefault()
    e.stopPropagation()
    const s = useEditor.getState()
    if (p.kind === 'effect' && 'effects' in item) {
      s.commit(updateItem<VisualItem>(s.project, item.id, { effects: [...item.effects, { id: uid('fx'), type: p.type as never, intensity: 60 }] }), 'Add effect', { selection: [item.id] })
      s.set({ activeRightTab: 'basic' })
    } else if (p.kind === 'filter' && (item.type === 'video' || item.type === 'image')) {
      s.commit(updateItem<VideoItem>(s.project, item.id, { filter: { id: p.id, intensity: 80 } }), 'Apply filter', { selection: [item.id] })
    } else if (p.kind === 'transition') {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const rightHalf = e.clientX > r.left + r.width / 2
      const target = rightHalf ? item.id : (() => {
        const f = findItem(s.project, item.id)
        const prev = f && f.track.items[f.index - 1]
        return prev && Math.abs(itemEnd(prev) - item.start) < 0.05 ? prev.id : item.id
      })()
      A.setTransition(target, p.type as TransitionType, 0.6)
    }
  }

  return (
    <>
      <div
        className={clsx('tl-clip', `t-${item.type}`, selected && 'sel', dragging && 'dragging', dropOn && 'drop', (track.locked || item.locked) && 'locked', muted && 'muted')}
        style={{ left, width, height: height - 2, ['--clip' as string]: color }}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
        onDragOver={onDragOver}
        onDragLeave={() => setDropOn(false)}
        onDrop={onDrop}
        title={`${label} · ${shortDuration(item.duration)}`}
      >
        {item.type === 'video' && asset && <Filmstrip asset={asset} item={item} width={width} height={height - 4} zoom={zoom} />}
        {item.type === 'image' && asset && <div className="tl-thumbs" style={{ backgroundImage: `url("${thumbUrl(asset)}")` }} />}
        {item.type === 'audio' && asset && <Waveform asset={asset} item={item} width={width} height={height - 6} />}
        {item.type === 'video' && asset?.waveform && !muted && track.main && <Waveform asset={asset} item={item} width={width} height={16} mini />}
        <div className="tl-clip-label">
          <Icon size={11} />
          <span className="nm">{label}</span>
          {width > 80 && <span className="du">{shortDuration(item.duration)}</span>}
          {speed && <span className="badge">{speed}×</span>}
          {item.type === 'video' && item.freezeAt !== undefined && <span className="badge">Freeze</span>}
          {'effects' in item && item.effects.length > 0 && width > 120 && <span className="badge">FX {item.effects.length}</span>}
          {(item.type === 'video' || item.type === 'image') && item.filter && width > 150 && <span className="badge">{FILTERS.find((f) => f.id === item.filter!.id)?.name ?? 'Filter'}</span>}
        </div>
        {(item.type === 'video' || item.type === 'audio') && item.fadeIn > 0 && <div className="tl-fade in" style={{ width: item.fadeIn * zoom }} />}
        {(item.type === 'video' || item.type === 'audio') && item.fadeOut > 0 && <div className="tl-fade out" style={{ width: item.fadeOut * zoom }} />}
        {kfTimes.map((t) => (
          <button
            key={t}
            className="tl-kfdot"
            style={{ left: t * zoom }}
            title={`Keyframe at ${t.toFixed(2)}s`}
            onPointerDown={(e) => {
              e.stopPropagation()
              useEditor.getState().select([item.id])
              A.seek(item.start + t)
            }}
          >
            <Diamond size={8} fill="currentColor" />
          </button>
        ))}
        {!track.locked && !item.locked && (
          <>
            <div className="tl-trim l" onPointerDown={(e) => onTrimDown(e, 'start')} />
            <div className="tl-trim r" onPointerDown={(e) => onTrimDown(e, 'end')} />
          </>
        )}
      </div>
      {cut && (
        <button
          className={clsx('tl-trans', tr && 'on')}
          style={{ left: left + width, width: tr ? Math.max(18, tr.duration * zoom) : 18, top: Math.round((height - 20) / 2) }}
          title={tr ? `${TRANSITIONS.find((x) => x.id === tr.type)?.name ?? tr.type} · ${tr.duration.toFixed(1)}s — click to edit` : 'Add transition'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            if (!tr) A.setTransition(item.id, 'crossfade', 0.6)
            cut(e)
          }}
          onDragOver={(e) => {
            if (dragPayload()?.kind === 'transition') {
              e.preventDefault()
              e.stopPropagation()
            }
          }}
          onDrop={(e) => {
            const p = dragPayload()
            if (p?.kind !== 'transition') return
            e.preventDefault()
            e.stopPropagation()
            A.setTransition(item.id, p.type as TransitionType, tr?.duration ?? 0.6)
          }}
        >
          <ArrowLeftRight size={10} />
        </button>
      )}
    </>
  )
})

function Filmstrip({ asset, item, width, height, zoom }: { asset: Asset; item: VideoItem; width: number; height: number; zoom: number }) {
  const strip = filmstripUrl(asset)
  const fs = asset.filmstrip
  const aspect = fs ? fs.frameWidth / fs.frameHeight : (asset.width ?? 16) / (asset.height ?? 9)
  const tileW = Math.max(12, height * aspect)
  const n = Math.min(300, Math.ceil(width / tileW))
  if (!strip || !fs) {
    const th = thumbUrl(asset)
    return <div className="tl-thumbs" style={{ backgroundImage: th ? `url("${th}")` : undefined }} />
  }
  const dur = asset.duration ?? 1
  const tiles = []
  for (let i = 0; i < n; i++) {
    const local = ((i + 0.5) * tileW) / zoom
    const src = item.freezeAt ?? (item.reverse ? item.in + (item.duration - local) * item.speed : item.in + local * item.speed)
    const idx = Math.max(0, Math.min(fs.frames - 1, Math.floor((src / dur) * fs.frames)))
    tiles.push(
      <div
        key={i}
        className="tl-tile"
        style={{ left: i * tileW, width: tileW, backgroundImage: `url("${strip}")`, backgroundSize: `${fs.frames * tileW}px ${height}px`, backgroundPosition: `${-idx * tileW}px 0` }}
      />,
    )
  }
  return <div className="tl-film">{tiles}</div>
}

function Waveform({ asset, item, width, height, mini }: { asset: Asset; item: VideoItem | Item; width: number; height: number; mini?: boolean }) {
  const wf = asset.waveform
  const it = item as VideoItem
  const path = useMemo(() => {
    if (!wf?.length) return ''
    const bars = Math.min(2000, Math.floor(width / 3))
    const perSec = 50
    const vol = Math.min(1.6, Math.max(0.15, it.volume ?? 1))
    let d = ''
    for (let j = 0; j < bars; j++) {
      const t0 = it.in + ((j * 3) / (width || 1)) * it.duration * it.speed
      const t1 = it.in + (((j + 1) * 3) / (width || 1)) * it.duration * it.speed
      let m = 0
      for (let k = Math.floor(t0 * perSec); k <= Math.floor(t1 * perSec) && k < wf.length; k++) m = Math.max(m, wf[k] ?? 0)
      const h = Math.max(1, m * vol * (height - 2) * (mini ? 1 : 0.92))
      const y = mini ? height - h : (height - h) / 2
      d += `M${j * 3} ${y.toFixed(1)}h2v${h.toFixed(1)}h-2z`
    }
    return d
  }, [wf, width, height, it.in, it.duration, it.speed, it.volume, mini])
  if (!path) return null
  return (
    <svg className={clsx('tl-wave', mini && 'mini')} width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={path} />
    </svg>
  )
}

// ---------- context menu & transition popover ----------

function ContextMenu({ ctx, onClose, onTransition }: { ctx: Ctx; onClose: () => void; onTransition: (itemId: string) => void }) {
  const project = useEditor((s) => s.project)
  const clipboard = useEditor((s) => s.clipboard)
  const f = ctx.itemId ? findItem(project, ctx.itemId) : null
  const it = f?.item
  const run = (fn: () => void) => () => {
    fn()
    onClose()
  }
  const x = Math.min(ctx.x, window.innerWidth - 230)
  const y = Math.min(ctx.y, window.innerHeight - (it ? 420 : 120))
  const canTransition = it && A.transitionTargetFor(it.id) !== null && it.type !== 'audio' && it.type !== 'caption'
  return (
    <Menu open onClose={onClose} className="tl-ctx" style={{ left: x, top: y }}>
      {it ? (
        <>
          <MenuItem icon={<Scissors size={14} />} label="Split" kbd="Ctrl B" onClick={run(A.split)} />
          <div className="ed-menu-sep" />
          <MenuItem icon={<Copy size={14} />} label="Copy" kbd="Ctrl C" onClick={run(A.copy)} />
          <MenuItem icon={<Scissors size={14} />} label="Cut" kbd="Ctrl X" onClick={run(A.cut)} />
          <MenuItem icon={<ClipboardPaste size={14} />} label="Paste" kbd="Ctrl V" onClick={run(A.paste)} disabled={!clipboard.length} />
          <MenuItem icon={<CopyPlus size={14} />} label="Duplicate" kbd="Ctrl D" onClick={run(A.duplicate)} />
          <div className="ed-menu-sep" />
          <MenuItem icon={<Trash2 size={14} />} label="Delete" kbd="Del" onClick={run(() => A.remove())} danger />
          <MenuItem icon={<Trash2 size={14} />} label="Ripple delete" kbd="Shift Del" onClick={run(() => A.remove(true))} danger />
          {it.type === 'video' && (
            <>
              <div className="ed-menu-sep" />
              <MenuItem icon={<SplitSquareHorizontal size={14} />} label="Separate audio" onClick={run(A.separate)} />
              <MenuItem icon={<Snowflake size={14} />} label="Freeze frame" onClick={run(A.freeze)} />
            </>
          )}
          {(it.type === 'video' || it.type === 'audio') && (
            <MenuItem icon={<FileText size={14} />} label="Transcript editing" onClick={run(() => useEditor.setState({ activeLeftTab: 'transcript', leftCollapsed: false }))} />
          )}
          {canTransition && (
            <MenuItem
              icon={<ArrowLeftRight size={14} />}
              label="Add transition"
              onClick={run(() => {
                const target = A.transitionTargetFor(it.id)!
                const cur = findItem(project, target)?.item as VisualItem | undefined
                if (!cur?.transitionOut) A.setTransition(target, 'crossfade', 0.6)
                onTransition(target)
              })}
            />
          )}
        </>
      ) : (
        <>
          <MenuItem icon={<ClipboardPaste size={14} />} label="Paste at playhead" kbd="Ctrl V" onClick={run(A.paste)} disabled={!clipboard.length} />
          <MenuItem icon={<Layers size={14} />} label="Select all" kbd="Ctrl A" onClick={run(A.selectAll)} />
          <MenuItem icon={<Scissors size={14} />} label="Split at playhead" kbd="Ctrl B" onClick={run(A.split)} />
        </>
      )}
    </Menu>
  )
}

function TransitionPopover({ pop, onClose }: { pop: TransPop; onClose: () => void }) {
  const project = useEditor((s) => s.project)
  const f = findItem(project, pop.itemId)
  const it = f?.item as VisualItem | undefined
  const tr = it?.transitionOut
  if (!it || !tr) return null
  const x = Math.min(pop.x - 140, window.innerWidth - 300)
  const y = Math.max(8, pop.y - 300)
  return (
    <Menu open onClose={onClose} className="tl-transpop" style={{ left: Math.max(8, x), top: y }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="eyebrow">Transition</span>
        <div className="spacer" />
        <button className="btn sm ghost icon" onClick={onClose} title="Close"><X size={14} /></button>
      </div>
      <div className="tl-transgrid">
        {TRANSITIONS.map((t) => (
          <button key={t.id} className={clsx(t.id === tr.type && 'on')} onClick={() => A.setTransition(it.id, t.id, tr.duration)}>
            {t.name}
          </button>
        ))}
      </div>
      <Slider
        label="Duration"
        value={tr.duration}
        min={0.1}
        max={2}
        step={0.05}
        suffix="s"
        onChange={(v) => {
          const s = useEditor.getState()
          s.commit(updateItem<VisualItem>(s.project, it.id, { transitionOut: { ...tr, duration: v } }), 'Transition duration', { coalesce: `trd:${it.id}` })
        }}
      />
      <button className="btn sm" style={{ width: '100%', marginTop: 8 }} onClick={() => { A.setTransition(it.id, null); onClose() }}>
        <Trash2 size={13} /> Remove transition
      </button>
    </Menu>
  )
}

