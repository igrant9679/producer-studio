// A footage window picked on the video itself (A-7): scrub the recording (slider, or ← → by a tenth, Shift by a
// second), see the frame, and set the window's start and end at the playhead; Play window plays just that part.
import { Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { mediaUrl } from '../../lib/api'
import { formatTime } from '../util'

export function clampWindow(start: number, end: number, duration: number): { start: number; end: number } {
  const d = Math.max(0, duration)
  const s = Math.min(Math.max(0, start), d)
  const e = Math.min(Math.max(0, end), d)
  return e > s ? { start: s, end: e } : { start: s, end: Math.min(d, s + 0.5) }
}

export function FootagePicker({ assetId, name, duration, start, end, onChange }: { assetId: string; name: string; duration?: number; start: number; end: number; onChange: (w: { start: number; end: number }) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [t, setT] = useState(start)
  const [length, setLength] = useState(duration ?? Math.max(end, 1))
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const v = video.current
    if (v && Math.abs(v.currentTime - t) > 0.04 && !playing) v.currentTime = t
  }, [t, playing])

  // playing the window stops at its end
  useEffect(() => {
    const v = video.current
    if (!v || !playing) return
    const tick = () => {
      setT(v.currentTime)
      if (v.currentTime >= end) {
        v.pause()
        setPlaying(false)
      }
    }
    v.addEventListener('timeupdate', tick)
    return () => v.removeEventListener('timeupdate', tick)
  }, [playing, end])

  function playWindow() {
    const v = video.current
    if (!v) return
    if (playing) {
      v.pause()
      setPlaying(false)
      return
    }
    v.currentTime = start
    setT(start)
    setPlaying(true)
    void v.play()?.catch(() => setPlaying(false))
  }

  const set = (w: { start: number; end: number }) => onChange(clampWindow(w.start, w.end, length))
  return (
    <div className="ps-fpick" role="group" aria-label={`Pick the footage window on ${name}`}>
      <video
        ref={video}
        className="ps-fpick-video"
        src={mediaUrl(assetId, 'proxy')}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setLength(e.currentTarget.duration)}
        onPause={() => setPlaying(false)}
      />
      <div className="ps-fpick-track" aria-hidden>
        <span className="ps-fpick-win" style={{ left: `${(start / length) * 100}%`, width: `${(Math.max(0, end - start) / length) * 100}%` }} />
      </div>
      <input
        type="range"
        className="ps-range"
        min={0}
        max={length}
        step={0.1}
        value={Math.min(t, length)}
        onChange={(e) => setT(Number(e.target.value))}
        onKeyDown={(e) => {
          // Shift: a second at a time
          if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault()
            setT((x) => Math.min(length, Math.max(0, x + (e.key === 'ArrowRight' ? 1 : -1))))
          }
        }}
        aria-label={`Scrub ${name}`}
        aria-valuetext={formatTime(t)}
      />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="kbd">{formatTime(t)}</span>
        <button type="button" className="btn sm" onClick={() => set({ start: t, end: Math.max(end, t + 0.5) })}>Start here</button>
        <button type="button" className="btn sm" onClick={() => set({ start: Math.min(start, Math.max(0, t - 0.5)), end: t })}>End here</button>
        <button type="button" className="btn ghost sm" onClick={playWindow} aria-pressed={playing}>{playing ? <Pause size={13} /> : <Play size={13} />} {playing ? 'Stop' : 'Play window'}</button>
        <span className="muted" style={{ fontSize: '0.75rem' }}>{formatTime(start)} – {formatTime(end)}</span>
      </div>
    </div>
  )
}
