// Transport clock: while `playing`, advance the playhead on every animation frame and stop at the end. It holds
// while the preview's media is buffering, and follows the media that is playing (the renderer's media clock), so a
// slow connection doesn't run the playhead ahead of a stalled video and captions stay with the sound. The canvas
// subscribes to playhead changes and renders; nothing else re-renders per frame unless it subscribes to the playhead.
import { projectDuration } from '@producer/core'
import { useEditor } from './store'

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
    let next = s.playhead + dt
    const m = mediaClock?.()
    if (m !== undefined && Math.abs(m - next) < 1) next += (m - next) * FOLLOW
    if (next >= end) {
      useEditor.setState({ playhead: end, playing: false })
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
    if (!s.playing && prev.playing) cancelAnimationFrame(raf)
  })
  return () => {
    unsub()
    cancelAnimationFrame(raf)
  }
}
