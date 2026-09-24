// Transport clock: while `playing`, advance the playhead by real elapsed time on every animation frame and
// stop at the end. The canvas subscribes to playhead changes and renders; nothing else re-renders per frame
// unless it explicitly subscribes to the playhead.
import { projectDuration } from '@producer/core'
import { useEditor } from './store'

export function startPlaybackClock(): () => void {
  let raf = 0
  let last = 0
  const tick = (now: number) => {
    const s = useEditor.getState()
    if (!s.playing) return
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
    last = now
    const end = projectDuration(s.project)
    const next = s.playhead + dt
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
