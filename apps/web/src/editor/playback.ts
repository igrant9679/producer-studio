// Transport clock: while `playing`, advance the playhead on every animation frame and stop at the end. It holds
// while the preview's media is buffering, and follows the media that is playing (the renderer's media clock), so a
// slow connection doesn't run the playhead ahead of a stalled video and captions stay with the sound. The canvas
// subscribes to playhead changes and renders; nothing else re-renders per frame unless it subscribes to the playhead.
import { projectDuration } from '@producer/core'
import { useEditor } from './store'
import { advance, playRate, rendererTransport, resetTransportFor, useTransport } from './transport'

let mediaClock: (() => number | undefined) | null = null

/** The canvas's renderer reports where its playing media is (timeline seconds); null when there is none. */
export function setMediaClock(fn: (() => number | undefined) | null) {
  mediaClock = fn
}

/** Share of the gap to the media's time closed each frame: no visible jumps, in step within a few frames. */
const FOLLOW = 0.2

export function startPlaybackClock(): () => void {
  let raf = 0
  let last = 0
  const tick = (now: number) => {
    const s = useEditor.getState()
    if (!s.playing) return
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
    last = now
    if (s.buffering) {
      // the media is loading: wait for it instead of running on
      raf = requestAnimationFrame(tick)
      return
    }
    const end = projectDuration(s.project)
    // at the shuttle and preview speed, round the loop when it is on (E-8)
    const step = advance(s.playhead, dt, end)
    let next = step.t
    const m = playRate() > 0 ? mediaClock?.() : undefined
    if (m !== undefined && Math.abs(m - next) < 1 && Math.abs(next - s.playhead) < 1) next += (m - next) * FOLLOW
    if (!step.playing) {
      useEditor.setState({ playhead: step.t, playing: false })
      return
    }
    useEditor.setState({ playhead: next })
    raf = requestAnimationFrame(tick)
  }
  const unsub = useEditor.subscribe((s, prev) => {
    if (s.playing && !prev.playing) {
      last = 0
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(tick)
    }
    if (!s.playing && prev.playing) {
      cancelAnimationFrame(raf)
      // the next play (Space, L) starts at normal speed forward
      if (useTransport.getState().shuttle !== 1) useTransport.setState({ shuttle: 1 })
    }
    if (s.session !== prev.session) resetTransportFor()
  })
  return () => {
    unsub()
    cancelAnimationFrame(raf)
  }
}

/** The canvas renderer follows the transport: its media play forward at the rate, or hold while the playhead goes back. */
export function applyTransport(r: { setPlaying: (playing: boolean, rate?: number) => void }, playing: boolean) {
  const t = rendererTransport(playing)
  r.setPlaying(t.playing, t.rate)
}
