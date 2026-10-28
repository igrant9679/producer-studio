// Track header sound button (E-14): a track's volume, solo, and ducking under voice, in a small popover. Solo and
// silenced-by-solo show on the button itself.
import type { Track } from '@producer/core'
import { DUCK_DEFAULT_DB, hasSound, setTrackSound, soloActive } from '@producer/core'
import clsx from 'clsx'
import { Headphones, SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditGate } from '../../shell/ui'
import { Field, Slider, Toggle } from '../controls'
import { useEditor } from '../store'
import './audio.css'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function TrackSoundButton({ track }: { track: Track }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const solo = useEditor((s) => soloActive(s.project))
  const gate = useEditGate()
  if (!hasSound(track)) return null
  const silenced = solo && !track.solo && !track.muted
  const vol = track.volume ?? 1
  const parts = [`volume ${Math.round(vol * 100)} %`, track.solo && 'soloed', silenced && 'silenced by a solo', track.duck && `ducks ${track.duck} dB under voice`].filter(Boolean)
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={`Sound of ${track.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={gate.tip ?? `Sound: ${parts.join(', ')}`}
        className={clsx(track.solo && 'solo', silenced && 'off')}
        disabled={!gate.canEdit}
        onClick={() => setOpen((o) => !o)}
      >
        {track.solo ? <Headphones size={13} /> : <SlidersHorizontal size={13} />}
      </button>
      {open && createPortal(<TrackSoundPopover track={track} anchor={btn.current} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

function TrackSoundPopover({ track, anchor, onClose }: { track: Track; anchor: HTMLElement | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const r = anchor?.getBoundingClientRect()
  const left = Math.max(8, Math.min((r?.left ?? 0) - 8, window.innerWidth - 280))
  const top = Math.max(8, (r?.top ?? 0) - 230)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true })
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) close.current()
    }
    const id = setTimeout(() => window.addEventListener('pointerdown', onDown), 0)
    return () => {
      clearTimeout(id)
      window.removeEventListener('pointerdown', onDown)
      // back to the button, unless focus already went somewhere else on the page
      const at = document.activeElement
      if (anchor?.isConnected && (!at || at === document.body || ref.current?.contains(at))) anchor.focus({ preventScroll: true })
    }
  }, [anchor])
  const set = (patch: Parameters<typeof setTrackSound>[2], label: string, coalesce?: string) => {
    const s = useEditor.getState()
    s.commit(setTrackSound(s.project, track.id, patch), label, coalesce ? { coalesce } : undefined)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Tab') {
      // focus stays in the popover until it is closed
      const all = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      const i = all.indexOf(document.activeElement as HTMLElement)
      const to = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : i === all.length - 1 ? 0 : i + 1
      e.preventDefault()
      all[to]?.focus()
    }
  }
  const duck = track.duck ?? 0
  return (
    <div ref={ref} className="tl-soundpop" role="dialog" aria-label={`Sound of ${track.name}`} style={{ left, top }} onKeyDown={onKeyDown} onPointerDown={(e) => e.stopPropagation()}>
      <span className="eyebrow">Track sound</span>
      <Slider
        label="Volume"
        value={track.volume ?? 1}
        min={0}
        max={2}
        step={0.01}
        suffix="%"
        display={{ to: (v) => v * 100, from: (v) => v / 100, step: 1 }}
        neutral={1}
        onChange={(v) => set({ volume: v }, 'Track volume', `tvol:${track.id}`)}
      />
      <Field label="Solo">
        <Toggle checked={!!track.solo} onChange={(v) => set({ solo: v }, v ? 'Solo track' : 'Unsolo track')} />
      </Field>
      <Field label="Duck under voice">
        <Toggle checked={duck > 0} onChange={(v) => set({ duck: v ? DUCK_DEFAULT_DB : 0 }, v ? 'Duck under voice' : 'Stop ducking')} />
      </Field>
      {duck > 0 && <Slider label="Duck by" value={duck} min={3} max={24} step={1} suffix="dB" onChange={(v) => set({ duck: v }, 'Duck amount', `tduck:${track.id}`)} />}
      <p className="ed-note">
        {duck > 0
          ? 'This track drops while a voiceover or a clip with a transcript is speaking, and comes back after.'
          : 'Solo plays only the soloed tracks. Ducking lowers music while someone speaks.'}
      </p>
    </div>
  )
}
