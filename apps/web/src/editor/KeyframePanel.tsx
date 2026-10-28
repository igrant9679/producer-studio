// Keyframe editing in the properties panel: a lane per animated property with draggable marks, the ease of each
// keyframe (with a curve editor for a custom curve), previous / next, and copy / paste of keyframes.
import type { AnimProp, Bezier, EaseName, Item } from '@producer/core'
import { EASE_CURVES, EASE_NAMES, adjacentKeyframe, copyKeyframes, editable, findItem, keyframeAt, moveKeyframes, pasteKeyframes, removeKeyframe, setKeyframe, setKeyframeEase } from '@producer/core'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, ClipboardPaste, Copy, Diamond, Trash2 } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import * as A from './actions'
import { Field, NumberInput, Section, useThrottledPlayhead } from './controls'
import { CurveEditor } from './CurveEditor'
import { jumpToKeyframe, keyframeClipboard, setKeyframeClipboard, subscribeKeyframeClipboard } from './keyframeActions'
import { useEditor } from './store'
import './canvas-tools.css'

export const PROP_LABELS: Record<AnimProp, string> = { x: 'Position X', y: 'Position Y', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity', volume: 'Volume' }

const S = () => useEditor.getState()

function props(it: Item, only?: AnimProp[]): AnimProp[] {
  if (!('keyframes' in it)) return []
  const all: AnimProp[] = only ?? ['x', 'y', 'scale', 'rotation', 'opacity', 'volume']
  return all.filter((k) => it.keyframes[k]?.length)
}

const fmt = (prop: AnimProp, v: number) => (prop === 'scale' || prop === 'opacity' || prop === 'volume' ? `${Math.round(v * 100)}%` : prop === 'rotation' ? `${+v.toFixed(1)}°` : `${Math.round(v)} px`)

interface Sel {
  prop: AnimProp
  t: number
}

/** The Keyframes section: `only` limits it to some properties (the Audio tab shows volume, the Transform tab the rest). */
export function KeyframesSection({ item, only }: { item: Item; only: AnimProp[] }) {
  const fps = useEditor((s) => s.project.fps)
  const playhead = useThrottledPlayhead()
  const copied = useSyncExternalStore(subscribeKeyframeClipboard, keyframeClipboard)
  const [sel, setSel] = useState<Sel | null>(null)
  useEffect(() => setSel(null), [item.id])
  const animated = props(item, only)
  const lt = playhead - item.start
  const selKf = sel ? keyframeAt(item, sel.prop, sel.t, fps) : undefined
  const inside = lt >= -1e-6 && lt <= item.duration + 1e-6
  const anyKf = animated.length > 0
  const prev = adjacentKeyframe(item, lt, -1, fps) !== undefined && animated.length > 0
  const next = adjacentKeyframe(item, lt, 1, fps) !== undefined && animated.length > 0

  const copy = () => {
    const c = copyKeyframes(item, selKf ? [sel!.prop] : animated, selKf ? [selKf.t] : undefined, fps)
    if (c) setKeyframeClipboard(c)
  }
  const paste = () => {
    if (!copied) return
    const s = S()
    const p = pasteKeyframes(s.project, item.id, copied, inside ? lt : 0)
    if (p !== s.project) s.commit(p, 'Paste keyframes')
  }

  return (
    <Section
      title="Keyframes"
      right={
        <>
          <button type="button" className="ed-mini" aria-label="Previous keyframe" title="Previous keyframe (Alt [)" disabled={!prev} onClick={() => jumpToKeyframe(-1)}>
            <ChevronLeft size={13} />
          </button>
          <button type="button" className="ed-mini" aria-label="Next keyframe" title="Next keyframe (Alt ])" disabled={!next} onClick={() => jumpToKeyframe(1)}>
            <ChevronRight size={13} />
          </button>
        </>
      }
    >
      {!anyKf && <p className="ed-note">Click ◇ beside a property to add a keyframe at the playhead; add a second at another time to animate it.</p>}
      {animated.map((prop) => (
        <KeyframeLane key={prop} item={item} prop={prop} playhead={lt} sel={sel} onSelect={setSel} />
      ))}
      <div className="row kf-actions">
        <button type="button" className="btn sm" disabled={!anyKf} onClick={copy} title={selKf ? 'Copy the selected keyframe' : 'Copy every keyframe shown here'}>
          <Copy size={13} /> {selKf ? 'Copy keyframe' : 'Copy keyframes'}
        </button>
        <button type="button" className="btn sm" disabled={!copied} onClick={paste} title="Paste copied keyframes at the playhead">
          <ClipboardPaste size={13} /> Paste
        </button>
      </div>
      {sel && selKf && <KeyframeDetail item={item} sel={sel} onMoved={(t) => setSel({ ...sel, t })} onRemoved={() => setSel(null)} />}
    </Section>
  )
}

function KeyframeLane({ item, prop, playhead, sel, onSelect }: { item: Item; prop: AnimProp; playhead: number; sel: Sel | null; onSelect: (s: Sel | null) => void }) {
  const fps = useEditor((s) => s.project.fps)
  const kfs = ('keyframes' in item ? item.keyframes[prop] : undefined) ?? []
  const dur = Math.max(1e-3, item.duration)
  const shown = kfs.filter((k) => k.t >= -1e-3 && k.t <= item.duration + 1e-3)
  const label = PROP_LABELS[prop]

  const move = (from: number, to: number, coalesce?: string) => {
    const s = S()
    const snapped = Math.round(to * fps) / fps
    const p = moveKeyframes(s.project, item.id, from, snapped, [prop])
    if (p === s.project) return from
    s.commit(p, 'Move keyframe', coalesce ? { coalesce } : undefined)
    return Math.max(0, Math.min(item.duration, +snapped.toFixed(4)))
  }

  const down = (e: React.PointerEvent<HTMLButtonElement>, t0: number) => {
    if (e.button > 0) return
    e.preventDefault()
    const lane = e.currentTarget.parentElement!.getBoundingClientRect()
    onSelect({ prop, t: t0 })
    A.seek(item.start + t0)
    if (!editable(findItem(S().project, item.id))) return
    const orig = S().project
    const x0 = e.clientX
    let moved = false
    let cur = t0
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      if (!moved && Math.abs(dx) < 3) return
      moved = true
      const to = Math.round((t0 + (dx / Math.max(1, lane.width)) * dur) * fps) / fps
      const s = S()
      const p = moveKeyframes(orig, item.id, t0, to, [prop])
      s.commit(p, 'Move keyframe', { coalesce: `kfmove:${item.id}:${prop}` })
      cur = Math.max(0, Math.min(item.duration, +to.toFixed(4)))
      onSelect({ prop, t: cur })
      A.seek(item.start + cur)
    }
    const up = () => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', up)
      S().endCoalesce()
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
  }

  const key = (e: React.KeyboardEvent, t: number) => {
    const step = (e.shiftKey ? 10 : 1) / fps
    let handled = true
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const to = move(t, t + (e.key === 'ArrowLeft' ? -step : step), `kfkey:${item.id}:${prop}`)
      onSelect({ prop, t: to })
      A.seek(item.start + to)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const s = S()
      const p = removeKeyframe(s.project, item.id, prop, t)
      if (p !== s.project) s.commit(p, 'Remove keyframe')
      onSelect(null)
    } else if (e.key === 'Home' || e.key === 'End') {
      const list = shown.map((k) => k.t)
      const to = e.key === 'Home' ? list[0] : list[list.length - 1]
      if (to !== undefined) {
        onSelect({ prop, t: to })
        A.seek(item.start + to)
        ;(e.currentTarget.parentElement?.querySelector(`[data-kf-t="${to}"]`) as HTMLElement | null)?.focus()
      }
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  return (
    <div className="kf-row">
      <span className="kf-name">{label}</span>
      <div className="kf-lane" role="group" aria-label={`${label} keyframes`} data-local-keys>
        {playhead >= 0 && playhead <= item.duration && <div className="kf-head" style={{ left: `${(playhead / dur) * 100}%` }} />}
        {shown.map((k, i) => {
          const on = !!sel && sel.prop === prop && Math.abs(sel.t - k.t) < 1 / (fps * 2)
          return (
            <button
              // by position, so a mark keeps focus while the arrow keys move it
              key={i}
              type="button"
              data-kf-t={k.t}
              className={clsx('kf-mark', on && 'on', k.ease === 'hold' && 'hold', k.ease === 'bezier' && 'curve')}
              style={{ left: `${(k.t / dur) * 100}%` }}
              aria-label={`${label} keyframe at ${k.t.toFixed(2)} s, ${fmt(prop, k.value)}`}
              aria-pressed={on}
              title={`${fmt(prop, k.value)} at ${k.t.toFixed(2)} s · drag or ← → to move, Delete to remove`}
              onPointerDown={(e) => down(e, k.t)}
              onClick={() => {
                onSelect({ prop, t: k.t })
                A.seek(item.start + k.t)
              }}
              onKeyDown={(e) => key(e, k.t)}
            >
              <Diamond size={9} fill="currentColor" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function KeyframeDetail({ item, sel, onMoved, onRemoved }: { item: Item; sel: Sel; onMoved: (t: number) => void; onRemoved: () => void }) {
  const fps = useEditor((s) => s.project.fps)
  const kf = keyframeAt(item, sel.prop, sel.t, fps)!
  const list = ('keyframes' in item ? item.keyframes[sel.prop] : undefined) ?? []
  const last = list.indexOf(kf) === list.length - 1
  const pct = sel.prop === 'scale' || sel.prop === 'opacity' || sel.prop === 'volume'
  const ease = kf.ease ?? 'linear'
  const setEase = (e: EaseName, b?: Bezier, coalesce?: string) => {
    const s = S()
    const p = setKeyframeEase(s.project, item.id, sel.prop, kf.t, e, b)
    if (p !== s.project) s.commit(p, 'Keyframe ease', coalesce ? { coalesce } : undefined)
  }
  const curve: Bezier = kf.ease === 'bezier' && kf.bezier ? kf.bezier : EASE_CURVES[(ease in EASE_CURVES ? ease : 'linear') as keyof typeof EASE_CURVES]
  return (
    <div className="kf-detail" role="group" aria-label={`${PROP_LABELS[sel.prop]} keyframe`}>
      <Field label="Time">
        <NumberInput
          value={kf.t}
          step={1 / fps}
          min={0}
          max={item.duration}
          suffix="s"
          width={86}
          onChange={(v) => {
            const s = S()
            const to = Math.round(v * fps) / fps
            const p = moveKeyframes(s.project, item.id, kf.t, to, [sel.prop])
            if (p !== s.project) {
              s.commit(p, 'Move keyframe')
              onMoved(Math.max(0, Math.min(item.duration, +to.toFixed(4))))
            }
          }}
        />
      </Field>
      <Field label="Value">
        <NumberInput
          value={pct ? kf.value * 100 : kf.value}
          step={1}
          suffix={pct ? '%' : sel.prop === 'rotation' ? '°' : 'px'}
          width={86}
          onChange={(v) => {
            const s = S()
            const p = setKeyframe(s.project, item.id, sel.prop, kf.t, pct ? v / 100 : v)
            if (p !== s.project) s.commit(p, 'Keyframe value')
          }}
        />
      </Field>
      <Field label="Ease">
        <select
          className="ed-select"
          aria-label="Ease"
          value={ease}
          disabled={last}
          title={last ? 'The last keyframe has nothing to ease into' : 'How the value moves from this keyframe to the next'}
          onChange={(e) => {
            const v = e.target.value as EaseName
            setEase(v, v === 'bezier' ? curve : undefined)
          }}
        >
          {EASE_NAMES.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
      </Field>
      {!last && ease === 'bezier' && <CurveEditor value={curve} onChange={(b, drag) => setEase('bezier', b, drag ? `kfcurve:${item.id}:${sel.prop}:${kf.t}` : undefined)} onEnd={() => S().endCoalesce()} />}
      <button
        type="button"
        className="btn sm"
        onClick={() => {
          const s = S()
          const p = removeKeyframe(s.project, item.id, sel.prop, kf.t)
          if (p !== s.project) s.commit(p, 'Remove keyframe')
          onRemoved()
        }}
      >
        <Trash2 size={13} /> Remove keyframe
      </button>
    </div>
  )
}
