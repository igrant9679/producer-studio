// The transport clock waits for buffering media and follows the media that plays (EDT-24).
import { addAsset, addItem, createProject, createVideoItem } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMediaClock, startPlaybackClock } from './playback'
import { useEditor } from './store'

const S = () => useEditor.getState()

let frames: Array<(t: number) => void> = []
let now = 0
/** Run `n` animation frames of 1/60 s. */
function run(n: number) {
  for (let i = 0; i < n; i++) {
    now += 1000 / 60
    const due = frames
    frames = []
    for (const f of due) f(now)
  }
}

let stop: () => void
beforeEach(() => {
  frames = []
  now = 1000
  vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => (frames.push(f), frames.length))
  vi.stubGlobal('cancelAnimationFrame', () => (frames = []))
  let p = createProject({ id: 'p1' })
  p = addAsset(p, { id: 'a', kind: 'video', name: 'a.mp4', src: '/api/media/a/source', duration: 60 })
  p = addItem(p, createVideoItem(p.assets.a, 0))
  S().load({ project: p, version: 1, projectId: 'p1', demo: true })
  stop = startPlaybackClock()
})
afterEach(() => {
  stop()
  setMediaClock(null)
  useEditor.setState({ playing: false, buffering: false })
  vi.unstubAllGlobals()
})

describe('the preview clock (EDT-24)', () => {
  it('runs with real time while the media keeps up', () => {
    S().setPlaying(true)
    run(61)
    expect(S().playhead).toBeCloseTo(1, 1)
  })

  it('waits while the media is buffering instead of running on', () => {
    S().setPlaying(true)
    run(31)
    const at = S().playhead
    useEditor.setState({ buffering: true })
    run(120)
    expect(S().playhead).toBe(at)
    useEditor.setState({ buffering: false })
    run(30)
    expect(S().playhead).toBeGreaterThan(at + 0.4)
    expect(S().playhead).toBeLessThan(at + 0.6)
  })

  it('follows the sound that is playing, so captions stay with it', () => {
    S().setPlaying(true)
    run(2)
    // the sound is 0.3 s behind the playhead (it started late) and plays on at real speed
    const base = S().playhead - 0.3
    const start = now
    setMediaClock(() => base + (now - start) / 1000)
    run(60)
    const media = base + (now - start) / 1000
    expect(Math.abs(S().playhead - media)).toBeLessThan(0.03)
  })
})
