// The volume rubber band and fade handles drawn on a clip that makes sound (E-15). The line is the clip's own level
// (volume keyframes and fades, 100 % across the middle, 200 % at the top). On a selected clip: drag the line up or
// down to change the level (every keyframe moves with it), double-click or Ctrl+click it to add a keyframe, drag a
// keyframe to move it, double-click one to remove it, and drag the corner handles to set the fades. Each part is a
// slider by keyboard too.
import type { AudioItem, Keyframe, VideoItem } from '@producer/core'
import { MAX_GAIN, clipLevel, sampleKeyframes, setVolumeKeyframes, updateItem } from '@producer/core'
import clsx from 'clsx'
import { useMemo } from 'react'
import { useEditGate } from '../../shell/ui'
import { useEditor } from '../store'
import './audio.css'

/** The top of the band: 200 %. */
const VMAX = 2
const PAD = 3

type Sound = VideoItem | AudioItem

const pct = (v: number) => `${Math.round(v * 100)} %`

interface Props {
  item: Sound
  width: number
  height: number
  zoom: number
  selected: boolean
  locked: boolean
}

/** Whether a clip gets the band: audio clips, and video clips that play their own sound. */
export function hasBand(item: Sound, hasAudio: boolean | undefined): boolean {
  if (item.type === 'audio') return true
  return !item.muted && item.freezeAt === undefined && !item.reverse && hasAudio !== false
}

/** Follow the pointer from a press until release; `move` gets the offset (px) from where it started. */
function follow(e: React.PointerEvent, move: (dx: number, dy: number, ev: PointerEvent) => void) {
  e.preventDefault()
  e.stopPropagation()
  const sx = e.clientX
  const sy = e.clientY
  const mv = (ev: PointerEvent) => move(ev.clientX - sx, ev.clientY - sy, ev)
  const up = () => {
    window.removeEventListener('pointermove', mv)
    window.removeEventListener('pointerup', up)
    useEditor.getState().endCoalesce()
  }
  window.addEventListener('pointermove', mv)
  window.addEventListener('pointerup', up)
}

const commit = (fn: (p: ReturnType<typeof useEditor.getState>['project']) => ReturnType<typeof useEditor.getState>['project'], label: string, coalesce?: string) => {
  const s = useEditor.getState()
  s.commit(fn(s.project), label, coalesce ? { coalesce } : undefined)
}

export function ClipAudioOverlay({ item, width, height, zoom, selected, locked }: Props) {
  const gate = useEditGate()
  const fps = useEditor((s) => s.project.fps)
  const h = Math.max(4, height - PAD * 2 - 2)
  const yOf = (v: number) => PAD + (1 - Math.min(VMAX, Math.max(0, v)) / VMAX) * h
  const kfs = item.keyframes?.volume ?? []
  const path = useMemo(() => {
    const step = Math.max(3, width / 400)
    const xs: number[] = []
    for (let x = 0; x < width; x += step) xs.push(x)
    xs.push(width)
    for (const x of [item.fadeIn * zoom, width - item.fadeOut * zoom, ...kfs.map((k) => k.t * zoom)]) if (x > 0 && x < width) xs.push(x)
    xs.sort((a, b) => a - b)
    return xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${yOf(clipLevel(item, x / zoom)).toFixed(1)}`).join('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, width, zoom, h])
  const live = selected && !locked && gate.canEdit
  const name = item.name ?? 'clip'
  const maxFade = Math.max(0.1, Math.min(10, item.duration / 2))
  const frame = 1 / (fps || 30)

  const setKfs = (list: Keyframe[], label: string, coalesce?: string) => commit((p) => setVolumeKeyframes(p, item.id, list), label, coalesce)
  /** Raise or lower the whole line by `dv`. */
  const shift = (base: Sound, dv: number, coalesce: string) => {
    const list = base.keyframes?.volume ?? []
    if (list.length) setKfs(list.map((k) => ({ ...k, value: k.value + dv })), 'Volume', coalesce)
    else commit((p) => updateItem<Sound>(p, item.id, { volume: Math.round(Math.min(MAX_GAIN, Math.max(0, base.volume + dv)) * 1000) / 1000 }), 'Volume', coalesce)
  }
  const addAt = (t: number) => {
    const lt = Math.max(0, Math.min(item.duration, t))
    if (kfs.some((k) => Math.abs(k.t - lt) < frame / 2)) return
    setKfs([...kfs, { t: lt, value: sampleKeyframes(kfs, lt, item.volume) }], 'Add volume keyframe')
  }
  const fade = (edge: 'in' | 'out', v: number, coalesce?: string) =>
    commit((p) => updateItem<Sound>(p, item.id, edge === 'in' ? { fadeIn: Math.round(Math.max(0, Math.min(maxFade, v)) * 100) / 100 } : { fadeOut: Math.round(Math.max(0, Math.min(maxFade, v)) * 100) / 100 }), edge === 'in' ? 'Fade in' : 'Fade out', coalesce)

  const onBandDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const x = e.clientX - (e.currentTarget as Element).closest('.tl-vband')!.getBoundingClientRect().left
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation()
      addAt(x / zoom)
      return
    }
    const base = item
    follow(e, (_dx, dy) => shift(base, (-dy / h) * VMAX, `band:${item.id}`))
  }
  const onBandKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01
    let handled = true
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') shift(item, step, `bandk:${item.id}`)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') shift(item, -step, `bandk:${item.id}`)
    else if (e.key === 'Enter' || e.key === 'k' || e.key === 'K') addAt(useEditor.getState().playhead - item.start)
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const onKfDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return
    const list = kfs
    const k0 = list[i]
    const lo = i > 0 ? list[i - 1].t + frame : 0
    const hi = i < list.length - 1 ? list[i + 1].t - frame : item.duration
    follow(e, (dx, dy) => {
      const t = Math.max(lo, Math.min(hi, k0.t + dx / zoom))
      const value = Math.max(0, Math.min(VMAX, k0.value - (dy / h) * VMAX))
      setKfs(list.map((k, j) => (j === i ? { ...k, t, value } : k)), 'Move volume keyframe', `kfv:${item.id}`)
    })
  }
  const removeKf = (i: number) => setKfs(kfs.filter((_, j) => j !== i), 'Remove volume keyframe')
  const onKfKey = (e: React.KeyboardEvent, i: number) => {
    const k = kfs[i]
    const big = e.shiftKey
    let next: Keyframe | null = null
    if (e.key === 'ArrowUp') next = { ...k, value: k.value + (big ? 0.1 : 0.01) }
    else if (e.key === 'ArrowDown') next = { ...k, value: k.value - (big ? 0.1 : 0.01) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const lo = i > 0 ? kfs[i - 1].t + frame : 0
      const hi = i < kfs.length - 1 ? kfs[i + 1].t - frame : item.duration
      const d = (e.key === 'ArrowLeft' ? -1 : 1) * (big ? 0.5 : frame)
      next = { ...k, t: Math.max(lo, Math.min(hi, k.t + d)) }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      const band = (e.currentTarget as HTMLElement).closest('.tl-vband')?.querySelector<HTMLElement>('.tl-vband-line')
      removeKf(i)
      band?.focus()
      return
    } else return
    e.preventDefault()
    e.stopPropagation()
    setKfs(kfs.map((x, j) => (j === i ? next! : x)), 'Move volume keyframe', `kfk:${item.id}`)
  }

  const onFadeDown = (e: React.PointerEvent, edge: 'in' | 'out') => {
    if (e.button !== 0) return
    const v0 = edge === 'in' ? item.fadeIn : item.fadeOut
    follow(e, (dx) => fade(edge, v0 + ((edge === 'in' ? dx : -dx) / zoom), `fade:${edge}:${item.id}`))
  }
  const onFadeKey = (e: React.KeyboardEvent, edge: 'in' | 'out') => {
    const v = edge === 'in' ? item.fadeIn : item.fadeOut
    const step = e.shiftKey ? 0.5 : 0.05
    // the handle moves the way the arrow points: right lengthens a fade in and shortens a fade out
    const dir = edge === 'in' ? 1 : -1
    let to: number | null = null
    if (e.key === 'ArrowRight') to = v + step * dir
    else if (e.key === 'ArrowLeft') to = v - step * dir
    else if (e.key === 'ArrowUp') to = v + step
    else if (e.key === 'ArrowDown') to = v - step
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = maxFade
    if (to === null) return
    e.preventDefault()
    e.stopPropagation()
    fade(edge, to, `fadek:${edge}:${item.id}`)
  }

  const tab = live ? 0 : -1
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <div className={clsx('tl-vband', live && 'live')} style={{ height }} onDoubleClick={stop}>
      <svg className="tl-vband-svg" width={width} height={height} aria-hidden="true">
        <path className="tl-vband-path" d={path} />
        {live && (
          <path
            className="tl-vband-hit"
            d={path}
            onPointerDown={onBandDown}
            onDoubleClick={(e) => {
              e.stopPropagation()
              const x = e.clientX - (e.currentTarget as Element).closest('.tl-vband')!.getBoundingClientRect().left
              addAt(x / zoom)
            }}
          />
        )}
      </svg>
      {live && (
        <>
          <div
            className="tl-vband-line"
            role="slider"
            tabIndex={tab}
            aria-label={`Volume of ${name}`}
            aria-valuemin={0}
            aria-valuemax={VMAX * 100}
            aria-valuenow={Math.round(sampleKeyframes(kfs, 0, item.volume) * 100)}
            aria-valuetext={kfs.length ? `${pct(sampleKeyframes(kfs, 0, item.volume))} at the start, ${kfs.length} keyframes` : pct(item.volume)}
            aria-keyshortcuts="ArrowUp ArrowDown Enter"
            title="Drag up or down to change the volume. Double-click or Ctrl+click to add a keyframe (keyboard: arrows, Enter adds one at the playhead)."
            onKeyDown={onBandKey}
            onPointerDown={stop}
          />
          {kfs.map((k, i) =>
            k.t >= 0 && k.t <= item.duration ? (
              <div
                key={i}
                className="tl-vkf"
                role="slider"
                tabIndex={tab}
                aria-label={`Volume keyframe ${i + 1} of ${name}`}
                aria-valuemin={0}
                aria-valuemax={VMAX * 100}
                aria-valuenow={Math.round(k.value * 100)}
                aria-valuetext={`${pct(k.value)} at ${k.t.toFixed(2)} s`}
                title={`${pct(k.value)} at ${k.t.toFixed(2)} s: drag to move, double-click to remove (keyboard: arrows, Delete)`}
                style={{ left: k.t * zoom, top: yOf(k.value) }}
                onPointerDown={(e) => onKfDown(e, i)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  removeKf(i)
                }}
                onKeyDown={(e) => onKfKey(e, i)}
              />
            ) : null,
          )}
          {(['in', 'out'] as const).map((edge) => {
            const v = edge === 'in' ? item.fadeIn : item.fadeOut
            const x = Math.min(width / 2, v * zoom)
            return (
              <div
                key={edge}
                className={clsx('tl-vfade', edge)}
                role="slider"
                tabIndex={tab}
                aria-label={`Fade ${edge} of ${name}`}
                aria-valuemin={0}
                aria-valuemax={maxFade}
                aria-valuenow={v}
                aria-valuetext={`${v.toFixed(2)} s`}
                title={`Fade ${edge} ${v.toFixed(2)} s: drag to change`}
                style={edge === 'in' ? { left: x } : { left: width - x }}
                onPointerDown={(e) => onFadeDown(e, edge)}
                onKeyDown={(e) => onFadeKey(e, edge)}
              />
            )
          })}
        </>
      )}
    </div>
  )
}
