// Review playback controls beside the play button (E-8): in and out points, loop, preview speed and quality,
// and the in-to-out band on the ruler.
import clsx from 'clsx'
import { ChevronDown, Repeat } from 'lucide-react'
import { useState } from 'react'
import { tipProps } from '../lib/tooltip'
import { Menu, MenuItem } from './controls'
import { timecode } from './timelineMath'
import { useEditor } from './store'
import { PREVIEW_SPEEDS, clearInOut, markIn, markOut, playRate, setFullQuality, setLoop, setPreviewSpeed, useTransport } from './transport'

const speedLabel = (v: number) => `${Number(v.toFixed(2))}×`

export function TransportControls() {
  const t = useTransport()
  const fps = useEditor((s) => s.project.fps)
  const playing = useEditor((s) => s.playing)
  const [open, setOpen] = useState(false)
  const hasRange = t.inPoint !== undefined || t.outPoint !== undefined
  const rate = playRate(t)
  const shuttling = playing && rate !== t.speed
  return (
    <div className="row tl-tx">
      <button className={clsx('tl-btn tl-mark', t.inPoint !== undefined && 'on')} {...tipProps('Mark in', t.inPoint !== undefined ? `In at ${timecode(t.inPoint, fps)}` : 'Start the part to loop or export at the playhead.', 'I', 'top')} onClick={() => markIn()}>
        I
      </button>
      <button className={clsx('tl-btn tl-mark', t.outPoint !== undefined && 'on')} {...tipProps('Mark out', t.outPoint !== undefined ? `Out at ${timecode(t.outPoint, fps)}` : 'End the part to loop or export at the playhead.', 'O', 'top')} onClick={() => markOut()}>
        O
      </button>
      <button className={clsx('tl-btn', t.loop && 'on')} aria-pressed={t.loop} {...tipProps('Loop playback', hasRange ? 'Play in to out over and over.' : 'Play the whole video over and over (mark in and out to loop a part).', undefined, 'top')} onClick={() => setLoop(!t.loop)}>
        <Repeat size={15} />
      </button>
      <div className="ed-dd tl-txmenu">
        <button className="ed-ddbtn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} {...tipProps('Playback speed and quality', 'Preview speed, and whether the preview plays the small editing copies or the original files. J K L shuttle backwards, stop and forwards.', undefined, 'top')}>
          <span className="mono">{shuttling ? `${rate < 0 ? '◀ ' : ''}${speedLabel(Math.abs(rate))}` : speedLabel(t.speed)}</span>
          {t.fullQuality && <span className="tl-hq">HQ</span>}
          <ChevronDown size={13} />
        </button>
        <Menu open={open} onClose={() => setOpen(false)} label="Playback">
          {PREVIEW_SPEEDS.map((v) => (
            <MenuItem key={v} label={`Speed ${speedLabel(v)}`} active={t.speed === v} onClick={() => (setPreviewSpeed(v), setOpen(false))} />
          ))}
          <div className="ed-menu-sep" />
          <MenuItem label="Proxy preview (smooth)" active={!t.fullQuality} onClick={() => (setFullQuality(false), setOpen(false))} />
          <MenuItem label="Full-quality preview" active={t.fullQuality} onClick={() => (setFullQuality(true), setOpen(false))} />
          <div className="ed-menu-sep" />
          <MenuItem label="Clear in and out" kbd="Alt X" disabled={!hasRange} onClick={() => (clearInOut(), setOpen(false))} />
        </Menu>
      </div>
    </div>
  )
}

/** The in-to-out part, shaded on the ruler. */
export function InOutBand({ zoom }: { zoom: number }) {
  const inPoint = useTransport((t) => t.inPoint)
  const outPoint = useTransport((t) => t.outPoint)
  const end = useEditor((s) => s.project.tracks.reduce((m, tr) => tr.items.reduce((n, i) => Math.max(n, i.start + i.duration), m), 0))
  if (inPoint === undefined && outPoint === undefined) return null
  const from = inPoint ?? 0
  const to = outPoint ?? end
  return (
    <div className="tl-inout" style={{ left: from * zoom, width: Math.max(0, to - from) * zoom }} aria-hidden="true">
      {inPoint !== undefined && <span className="in" />}
      {outPoint !== undefined && <span className="out" />}
    </div>
  )
}
