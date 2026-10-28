// The Speed tab of the Properties panel (E-17): a constant speed, a speed ramp (a preset, or points dragged on its
// curve), the pitch toggle, smooth slow motion, reverse, and the freeze frame controls (E-24). The clip badge on the
// timeline and the watcher that brings smooth copies in when their job is done live here too.
import type { AudioItem, Item, RampShape, SmoothCopyResult, VideoItem } from '@producer/core'
import {
  RAMP_PRESETS,
  SPEED_MAX,
  SPEED_MIN,
  applyRampPreset,
  applySmoothCopy,
  dropSmoothJob,
  findItem,
  isEditable,
  pendingSmoothJobs,
  rampOf,
  rampPresetOf,
  rampRate,
  rampShape,
  setItemSpeed,
  setPitchShift,
  setSmoothJob,
  setSpeedRamp,
  smoothFps,
  smoothRange,
  smoothState,
  updateItem,
} from '@producer/core'
import clsx from 'clsx'
import { Plus, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAnnounceChange } from '../lib/announce'
import { api, waitForJob } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import { useEditGate } from '../shell/ui'
import { LOCKED_NOTE, demoBlocked } from './actions'
import { Field, Section, Slider, Toggle } from './controls'
import { FreezeControls, FreezeHold } from './FreezeMenu'
import { useEditor } from './store'
import './speed.css'

const S = () => useEditor.getState()

const commit = (fn: (p: ReturnType<typeof S>['project']) => ReturnType<typeof S>['project'], label: string, coalesce?: string) => {
  const s = S()
  s.commit(fn(s.project), label, coalesce ? { coalesce } : undefined)
}

const times = (v: number) => `${+v.toFixed(2)}×`

export function SpeedTab({ item }: { item: VideoItem | AudioItem }) {
  const gate = useEditGate()
  const frozen = item.type === 'video' && item.freezeAt !== undefined
  const reversed = item.type === 'video' && !!item.reverse
  const ramp = rampOf(item)
  const setSpeed = (v: number) => commit((p) => setItemSpeed(p, item.id, v), 'Speed', `speed:${item.id}`)
  return (
    // a viewer reads the settings; nothing in here changes them (the curve's points aren't form controls: see RampEditor)
    <fieldset disabled={!gate.canEdit} className="ed-speed" title={gate.tip} onClickCapture={gate.canEdit ? undefined : (e) => (e.preventDefault(), e.stopPropagation())}>
      {!gate.canEdit && <p className="ed-note" role="note">{gate.tip}</p>}
      <Section title="Speed">
        {frozen ? (
          <>
            <p className="ed-note">This is a freeze-frame segment; speed doesn't apply.</p>
            <FreezeHold item={item as VideoItem} />
          </>
        ) : (
          <>
            <Slider label={ramp ? 'Average speed' : 'Speed'} value={item.speed} min={0.25} max={4} step={0.05} suffix="×" neutral={1} onChange={setSpeed} />
            {ramp && <p className="ed-note">This clip ramps its speed. Setting a speed here plays the whole clip at that one speed.</p>}
            <div className="ed-chiprow">
              {[0.5, 1, 1.5, 2, 3].map((s) => (
                <button key={s} type="button" className={clsx('chip', !ramp && Math.abs(item.speed - s) < 0.001 && 'active')} aria-pressed={!ramp && Math.abs(item.speed - s) < 0.001} onClick={() => setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </div>
            <Field label="Duration">
              <span className="ed-static mono">{item.duration.toFixed(2)} s</span>
            </Field>
          </>
        )}
        {item.type === 'video' && !frozen && (
          <Field label="Reverse">
            <Toggle checked={reversed} onChange={(v) => commit((p) => updateItem<VideoItem>(p, item.id, { reverse: v }), v ? 'Reverse' : 'Un-reverse')} label={<span className="muted">preview is approximate</span>} />
          </Field>
        )}
      </Section>
      {!frozen && <RampSection item={item} reversed={reversed} readOnly={!gate.canEdit} />}
      {!frozen && !reversed && <PitchSection item={item} />}
      {item.type === 'video' && !frozen && !reversed && <SmoothSection item={item} />}
      {item.type === 'video' && !frozen && (
        <Section title="Freeze frame">
          <p className="ed-note">Holds a frame still: the one under the playhead, or the clip's last frame after it.</p>
          <FreezeControls />
        </Section>
      )}
    </fieldset>
  )
}

// ---------- speed ramp ----------

function RampSection({ item, reversed, readOnly }: { item: VideoItem | AudioItem; reversed: boolean; readOnly?: boolean }) {
  if (reversed) {
    return (
      <Section title="Speed ramp">
        <p className="ed-note">A reversed clip plays at one speed. Turn Reverse off to ramp it.</p>
      </Section>
    )
  }
  const shape = rampShape(item)
  const preset = rampPresetOf(item)
  return (
    <Section title="Speed ramp">
      <p className="ed-note">Speed up and slow down within the clip. It keeps the same stretch of the recording, so its length changes.</p>
      <div className="ed-chiprow" role="group" aria-label="Speed ramp presets">
        <button type="button" className={clsx('chip', !shape && 'active')} aria-pressed={!shape} onClick={() => commit((p) => setSpeedRamp(p, item.id, null), 'No speed ramp')}>
          None
        </button>
        {RAMP_PRESETS.map((x) => (
          <button key={x.id} type="button" className={clsx('chip', preset === x.id && 'active')} aria-pressed={preset === x.id} title={x.hint} onClick={() => commit((p) => applyRampPreset(p, item.id, x.id), `Speed ramp: ${x.name}`)}>
            {x.name}
          </button>
        ))}
      </div>
      <RampEditor item={item} shape={shape ?? [{ t: 0, v: item.speed }, { t: 1, v: item.speed }]} readOnly={readOnly} />
    </Section>
  )
}

const W = 236
const H = 104
const PAD = 12
const LOG_LO = Math.log(SPEED_MIN)
const LOG_HI = Math.log(SPEED_MAX)
const xOf = (t: number) => PAD + t * (W - 2 * PAD)
const yOf = (v: number) => PAD + (1 - (Math.log(v) - LOG_LO) / (LOG_HI - LOG_LO)) * (H - 2 * PAD)
const vOfY = (y: number) => Math.exp(LOG_LO + (1 - (y - PAD) / (H - 2 * PAD)) * (LOG_HI - LOG_LO))
const tOfX = (x: number) => (x - PAD) / (W - 2 * PAD)
const clampV = (v: number) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, v))

/**
 * The ramp drawn over the clip's length: speed on a log scale (1× marked), a point at each change. Drag a point, or
 * focus it and use the arrow keys (up and down: speed, left and right: where in the clip; Shift for bigger steps);
 * Delete removes a point in the middle. Add point puts one where the playhead is.
 */
export function RampEditor({ item, shape, readOnly }: { item: VideoItem | AudioItem; shape: RampShape; readOnly?: boolean }) {
  const svg = useRef<SVGSVGElement>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const playhead = useEditor((s) => s.playhead)
  const apply = (next: RampShape, label = 'Speed ramp', drag = true) => !readOnly && commit((p) => setSpeedRamp(p, item.id, next), label, drag ? `ramp:${item.id}` : undefined)
  const move = (i: number, t: number, v: number, drag = true) => {
    const next = shape.map((q) => ({ ...q }))
    const lo = i === 0 ? 0 : next[i - 1].t + 0.01
    const hi = i === next.length - 1 ? 1 : next[i + 1].t - 0.01
    // the ends stay at the clip's ends
    next[i] = { t: i === 0 ? 0 : i === next.length - 1 ? 1 : Math.min(hi, Math.max(lo, t)), v: +clampV(v).toFixed(3) }
    apply(next, 'Speed ramp', drag)
  }
  const remove = (i: number) => {
    if (i === 0 || i === shape.length - 1) return
    apply(shape.filter((_, k) => k !== i), 'Remove ramp point', false)
    setFocus(Math.max(0, i - 1))
  }
  const add = () => {
    const local = playhead - item.start
    const t = local > 0 && local < item.duration ? local / item.duration : 0.5
    if (shape.some((q) => Math.abs(q.t - t) < 0.02)) return
    const v = +rampRate(shape, t).toFixed(3)
    const next = [...shape, { t, v }].sort((a, b) => a.t - b.t)
    apply(next, 'Add ramp point', false)
    setFocus(next.findIndex((q) => q.t === t))
  }
  const down = (e: React.PointerEvent, i: number) => {
    if (readOnly) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as SVGElement).focus?.()
    setFocus(i)
    const r = svg.current!.getBoundingClientRect()
    const k = r.width / W || 1
    const mv = (ev: PointerEvent) => move(i, tOfX((ev.clientX - r.left) / k), vOfY((ev.clientY - r.top) / k))
    const up = () => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', up)
      S().endCoalesce()
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
  }
  const key = (e: React.KeyboardEvent, i: number) => {
    const q = shape[i]
    const big = e.shiftKey
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      const f = big ? 1.25 : 1.05
      move(i, q.t, e.key === 'ArrowUp' ? q.v * f : q.v / f)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      e.stopPropagation()
      const d = (big ? 0.05 : 0.01) * (e.key === 'ArrowRight' ? 1 : -1)
      move(i, q.t + d, q.v)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      remove(i)
    }
  }
  // keep the focused point focused across re-renders (a commit makes new elements only when points come and go)
  useEffect(() => {
    if (focus === null) return
    const el = svg.current?.querySelectorAll<SVGCircleElement>('.ed-ramp-pt')[focus]
    if (el && document.activeElement !== el && svg.current?.contains(document.activeElement)) el.focus()
  }, [focus, shape.length])
  const path = Array.from({ length: 61 }, (_, k) => {
    const t = k / 60
    return `${k ? 'L' : 'M'}${xOf(t).toFixed(1)},${yOf(rampRate(shape, t)).toFixed(1)}`
  }).join(' ')
  const ph = (playhead - item.start) / Math.max(1e-6, item.duration)
  return (
    <div className="ed-ramp">
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="group" aria-label="Speed ramp curve: speed over the length of the clip">
        <rect x={xOf(0)} y={PAD} width={xOf(1) - xOf(0)} height={H - 2 * PAD} className="ed-ramp-box" />
        <line x1={xOf(0)} x2={xOf(1)} y1={yOf(1)} y2={yOf(1)} className="ed-ramp-one" />
        <text x={xOf(0) + 2} y={yOf(1) - 3} className="ed-ramp-lbl">1×</text>
        {ph > 0 && ph < 1 && <line x1={xOf(ph)} x2={xOf(ph)} y1={PAD} y2={H - PAD} className="ed-ramp-ph" />}
        <path d={path} className="ed-ramp-line" />
        {shape.map((q, i) => (
          <circle
            key={i}
            cx={xOf(q.t)}
            cy={yOf(q.v)}
            r={5.5}
            className="ed-ramp-pt"
            tabIndex={0}
            role="slider"
            aria-label={i === 0 ? 'Speed at the start' : i === shape.length - 1 ? 'Speed at the end' : `Speed point ${i} of ${shape.length - 2}`}
            aria-valuenow={q.v}
            aria-valuemin={SPEED_MIN}
            aria-valuemax={SPEED_MAX}
            aria-valuetext={`${times(q.v)} at ${Math.round(q.t * 100)}% of the clip`}
            aria-readonly={readOnly || undefined}
            onFocus={() => setFocus(i)}
            onPointerDown={(e) => down(e, i)}
            onKeyDown={(e) => key(e, i)}
            onKeyUp={() => S().endCoalesce()}
          />
        ))}
      </svg>
      <div className="ed-ramp-tools">
        <button type="button" className="btn sm" onClick={add}>
          <Plus size={13} /> Add point
        </button>
        <button type="button" className="btn sm ghost" disabled={focus === null || focus === 0 || focus >= shape.length - 1} onClick={() => focus !== null && remove(focus)}>
          <Trash2 size={13} /> Remove point
        </button>
      </div>
    </div>
  )
}

// ---------- pitch ----------

function PitchSection({ item }: { item: VideoItem | AudioItem }) {
  const silent = item.type === 'video' && useEditor.getState().project.assets[item.assetId]?.hasAudio === false
  return (
    <Section title="Pitch">
      <Field label="Keep pitch">
        <Toggle checked={!item.pitchShift} onChange={(keep) => commit((p) => setPitchShift(p, item.id, !keep), keep ? 'Keep pitch' : 'Pitch follows speed')} />
      </Field>
      <p className="ed-note">{silent ? 'This clip has no sound.' : item.pitchShift ? 'The pitch follows the speed: faster sounds higher, slower lower, like a tape.' : 'Voices keep their pitch at any speed.'}</p>
    </Section>
  )
}

// ---------- smooth slow motion ----------

/** Progress of the smooth copies being made, by job (0..1). */
const smoothProgress = (() => {
  let listeners: Array<() => void> = []
  const state: Record<string, number> = {}
  return {
    get: (id: string) => state[id],
    set: (id: string, f: number) => {
      state[id] = f
      for (const l of listeners) l()
    },
    subscribe: (l: () => void) => {
      listeners.push(l)
      return () => {
        listeners = listeners.filter((x) => x !== l)
      }
    },
  }
})()

function useJobProgress(jobId: string | undefined): number | undefined {
  const [, bump] = useState(0)
  useEffect(() => smoothProgress.subscribe(() => bump((n) => n + 1)), [])
  return jobId ? smoothProgress.get(jobId) : undefined
}

/** Ask the server for a smooth slow-motion copy of the clip's stretch; the clip shows it is being made. */
export async function startSmooth(itemId: string) {
  if (demoBlocked('smooth slow motion')) return
  const s = S()
  const it = findItem(s.project, itemId)?.item
  if (it?.type !== 'video') return toast('Smooth slow motion works on video clips')
  if (!isEditable(s.project, itemId)) return toast(LOCKED_NOTE)
  const fps = smoothFps(s.project, it)
  if (!fps) return toast('This clip already plays a new frame for every frame of the video')
  const range = smoothRange(s.project, it)
  const session = s.session
  try {
    const job = await api.smoothSlowMotion(it.assetId, { ...range, fps, projectId: s.projectId })
    const now = S()
    if (now.session !== session || !findItem(now.project, itemId)) return
    now.commit(setSmoothJob(now.project, itemId, { ...range, fps, jobId: job.id }), 'Smooth slow motion')
  } catch (e) {
    toastError(e, 'Couldn’t start the smooth slow motion')
  }
}

function SmoothSection({ item }: { item: VideoItem }) {
  const project = useEditor((s) => s.project)
  const state = smoothState(project, item)
  const fps = smoothFps(project, item)
  const progress = useJobProgress(item.smooth?.jobId)
  const off = () => commit((p) => setSmoothJob(p, item.id, null), 'Original frames')
  // said once when it starts and when it's ready, not each percent
  useAnnounceChange(state === 'making' ? 'Making smooth slow motion' : state === 'ready' ? 'Smooth slow motion ready' : undefined)
  return (
    <Section title="Smooth slow motion">
      {state === 'making' && (
        <p className="ed-note">
          Making the in-between frames{progress !== undefined ? ` (${Math.round(progress * 100)}%)` : ''}… The clip plays its original frames until they are ready.
        </p>
      )}
      {state === 'ready' && <p className="ed-note">Playing the smooth copy ({item.smooth!.fps} fps), with frames made in between.</p>}
      {state === 'stale' && <p className="ed-note">The smooth copy no longer covers this clip (it was made longer), so it plays its original frames.</p>}
      {state === 'none' && <p className="ed-note">{fps ? `Slowed down, this clip shows each frame for longer. Make the frames in between (${fps} fps) for smooth motion.` : 'For a clip slowed below 1×: makes the frames in between so slow motion plays smoothly.'}</p>}
      <div className="ed-ramp-tools">
        {(state === 'none' || state === 'stale') && (
          <button type="button" className="btn sm" disabled={!fps} onClick={() => void startSmooth(item.id)}>
            <Sparkles size={13} /> {state === 'stale' ? 'Make it again' : 'Make smooth slow motion'}
          </button>
        )}
        {(state === 'ready' || state === 'stale' || state === 'making') && (
          <button type="button" className="btn sm ghost" onClick={off}>
            {state === 'making' ? 'Don’t wait for it' : 'Use the original frames'}
          </button>
        )}
      </div>
    </Section>
  )
}

const watching = new Set<string>()

/** When a smooth copy's job ends, the clips waiting on it play from the copy (or go back to their own frames). */
async function watchSmoothJob(jobId: string) {
  if (watching.has(jobId)) return
  watching.add(jobId)
  const session = S().session
  try {
    const j = await waitForJob<SmoothCopyResult>(jobId, (u) => smoothProgress.set(jobId, u.progress))
    const now = S()
    if (now.session !== session || !j.result) return
    // not an edit of its own: undo goes back past "Smooth slow motion", and a step that waits on it gets it again
    now.replaceSilently(applySmoothCopy(now.project, jobId, j.result.asset, j.result.to))
    toast('Smooth slow motion is ready')
  } catch (e) {
    const now = S()
    if (now.session !== session) return
    now.replaceSilently(dropSmoothJob(now.project, jobId))
    toastError(e, 'Couldn’t make the smooth slow motion')
  } finally {
    watching.delete(jobId)
  }
}

/** Mounted once in the editor: watches every clip waiting on a smooth copy. */
export function SmoothJobsHost() {
  const pending = useEditor((s) => (s.demo ? '' : pendingSmoothJobs(s.project).join(',')))
  useEffect(() => {
    for (const id of pending.split(',').filter(Boolean)) void watchSmoothJob(id)
  }, [pending])
  return null
}

// ---------- the clip badge on the timeline ----------

/** The clip's speed on the timeline: 2×, a ramp, smoothing. */
export function SpeedBadge({ item }: { item: Item }) {
  const smooth = useEditor((s) => smoothState(s.project, item))
  if (item.type !== 'video' && item.type !== 'audio') return null
  const ramp = rampOf(item)
  return (
    <>
      {ramp ? (
        <span className="badge" title={`Speed ramp, ${times(item.speed)} on average`}>ramp</span>
      ) : (
        item.speed !== 1 && <span className="badge">{item.speed}×</span>
      )}
      {smooth === 'making' && (
        <span className="badge ed-smooth-badge" role="status" aria-label="Making smooth slow motion">
          smoothing…
        </span>
      )}
      {smooth === 'ready' && (
        <span className="badge" title="Smooth slow motion">
          smooth
        </span>
      )}
    </>
  )
}
