// Timeline markers on the ruler (E-6): click to jump, drag to move (snapping like clips; Alt for free), double-click
// or F2 to name, Delete to remove. One Tab stop for them all; the arrows go from marker to marker.
import { markersOf, removeMarkers, snapPoints, type Marker, type Project } from '@producer/core'
import clsx from 'clsx'
import { Pencil, Trash2 } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { tipProps } from '../lib/tooltip'
import * as A from './actions'
import { Menu, MenuItem } from './controls'
import { deleteMarker, moveMarker, renameMarker } from './markerActions'
import { useEditor } from './store'
import { isReadOnly, ViewOnly } from './viewer'
import { snapAt, timecode } from './timelineMath'

const S = () => useEditor.getState()

const nameOf = (m: Marker) => m.name || (m.beat ? 'Beat' : 'Marker')

export function MarkerFlags({ zoom, fps }: { zoom: number; fps: number }) {
  const raw = useEditor((s) => s.project.markers)
  const markers = useMemo(() => (raw?.length ? markersOf({ markers: raw } as Project) : []), [raw])
  const [stop, setStop] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const focusNext = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (focusNext.current) refs.current.get(focusNext.current)?.focus()
    focusNext.current = null
  })
  if (!markers.length) return null
  const tabStop = markers.some((m) => m.id === stop) ? stop : markers[0].id
  const focus = (id: string | undefined) => {
    if (!id) return
    setStop(id)
    focusNext.current = id
  }

  const onPointerDown = (e: React.PointerEvent, m: Marker) => {
    e.stopPropagation()
    if (e.button !== 0) return
    e.preventDefault()
    setStop(m.id)
    refs.current.get(m.id)?.focus()
    const sx = e.clientX
    const pts = snapPoints(removeMarkers(S().project, [m.id]), new Set(), S().playhead)
    let moved = false
    // a viewer's marker only jumps
    const fixed = isReadOnly()
    const move = (ev: PointerEvent) => {
      if (fixed || (!moved && Math.abs(ev.clientX - sx) < 3)) return
      moved = true
      const z = S().zoom
      let t = Math.max(0, m.t + (ev.clientX - sx) / z)
      if (S().snapping && !ev.altKey) t = snapAt(t, pts, z).t
      moveMarker(m.id, t)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      S().endCoalesce()
      if (!moved) {
        S().setPlaying(false)
        A.seek(m.t)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onKeyDown = (e: React.KeyboardEvent, m: Marker, i: number) => {
    const k = e.key
    const done = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && e.altKey) {
      done()
      const step = (e.shiftKey ? 1 : 1 / fps) * (k === 'ArrowLeft' ? -1 : 1)
      moveMarker(m.id, m.t + step)
      focus(m.id)
    } else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') {
      done()
      const to = k === 'Home' ? markers[0] : k === 'End' ? markers[markers.length - 1] : markers[i + (k === 'ArrowLeft' ? -1 : 1)]
      if (!to) return
      focus(to.id)
      S().setPlaying(false)
      A.seek(to.t)
    } else if (k === 'F2') {
      done()
      if (!isReadOnly()) setEditing(m.id)
    } else if (k === 'Delete' || k === 'Backspace') {
      done()
      const next = markers[i + 1] ?? markers[i - 1]
      deleteMarker(m.id)
      focus(next?.id)
    } else if (k === 'ContextMenu' || (e.shiftKey && k === 'F10')) {
      done()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setMenu({ id: m.id, x: r.left, y: r.bottom + 4 })
    }
  }

  const menuMarker = menu && markers.find((m) => m.id === menu.id)
  return (
    <div className="tl-markers" role="toolbar" aria-label="Markers" onPointerDown={(e) => e.stopPropagation()}>
      {markers.map((m, i) => (
        <button
          key={m.id}
          ref={(el) => {
            if (el) refs.current.set(m.id, el)
            else refs.current.delete(m.id)
          }}
          type="button"
          className={clsx('tl-marker', m.beat && 'beat')}
          style={{ left: m.t * zoom }}
          tabIndex={m.id === tabStop ? 0 : -1}
          {...tipProps(nameOf(m), `${timecode(m.t, fps)}. Click to jump here, drag to move, double-click or F2 to rename, Delete to remove.`, undefined, 'bottom')}
          aria-label={`${m.name || m.beat ? `${nameOf(m)} marker` : 'Marker'} at ${timecode(m.t, fps)}`}
          onPointerDown={(e) => onPointerDown(e, m)}
          onClick={(e) => {
            // a click by keyboard (Enter, Space) jumps; a pointer click jumps on release
            if (e.detail === 0) {
              S().setPlaying(false)
              A.seek(m.t)
            }
          }}
          onDoubleClick={() => !isReadOnly() && setEditing(m.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ id: m.id, x: e.clientX, y: e.clientY })
          }}
          onKeyDown={(e) => onKeyDown(e, m, i)}
        >
          <svg width="9" height="12" viewBox="0 0 9 12" aria-hidden="true">
            <path d="M0 0h9v8l-4.5 4L0 8z" />
          </svg>
          {m.name && zoom * ((markers[i + 1]?.t ?? Infinity) - m.t) > 40 && <span className="nm">{m.name}</span>}
        </button>
      ))}
      {editing && (
        <MarkerName
          marker={markers.find((m) => m.id === editing)}
          zoom={zoom}
          onDone={() => {
            focus(editing)
            setEditing(null)
          }}
        />
      )}
      {menu && menuMarker && (
        <Menu open onClose={() => setMenu(null)} className="tl-ctx" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: menu.y }} label="Marker">
          <ViewOnly inline>
          <MenuItem icon={<Pencil size={14} />} label="Rename marker" kbd="F2" onClick={() => (setMenu(null), setEditing(menuMarker.id))} />
          <MenuItem
            icon={<Trash2 size={14} />}
            label="Delete marker"
            kbd="Del"
            danger
            onClick={() => {
              setMenu(null)
              deleteMarker(menuMarker.id)
            }}
          />
          </ViewOnly>
        </Menu>
      )}
    </div>
  )
}

function MarkerName({ marker, zoom, onDone }: { marker: Marker | undefined; zoom: number; onDone: () => void }) {
  const cancelled = useRef(false)
  if (!marker) return null
  return (
    <input
      className="tl-marker-input"
      style={{ left: marker.t * zoom }}
      autoFocus
      maxLength={120}
      defaultValue={marker.name ?? ''}
      placeholder="Marker name"
      aria-label="Marker name"
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (!cancelled.current && e.target.value.trim() !== (marker.name ?? '')) renameMarker(marker.id, e.target.value)
        onDone()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          cancelled.current = true
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

/** A faint line down the tracks under each marker, so a clip edge can be lined up with it. */
export function MarkerLines({ zoom }: { zoom: number }) {
  const markers = useEditor((s) => s.project.markers)
  if (!markers?.length) return null
  return (
    <>
      {markers.map((m) => (
        <div key={m.id} className={clsx('tl-marker-line', m.beat && 'beat')} style={{ left: m.t * zoom }} />
      ))}
    </>
  )
}
