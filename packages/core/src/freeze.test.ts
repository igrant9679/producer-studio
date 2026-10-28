// Freeze frames (E-24): any hold length, and a hold at the end of a clip.
import { describe, expect, it } from 'vitest'
import { addAsset, addItem, createProject, createVideoItem, findItem, freezeAtEnd, mainTrack, separateAudio, setFreezeHold, type Asset, type Project, type VideoItem } from './index'

const video = (id: string, duration = 10): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration, width: 1920, height: 1080, hasAudio: true })

/** a (0-10) and b (10-20) on the main track, b's sound separated onto an audio track. */
function separated(): { p: Project; audio: string } {
  let p = createProject()
  p = addAsset(p, video('a'))
  p = addAsset(p, video('b'))
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
  p = addItem(p, createVideoItem(p.assets.b, 99, { id: 'vb' }))
  p = separateAudio(p, 'vb')
  return { p, audio: p.tracks.find((t) => t.kind === 'audio')!.items[0].id }
}

const at = (p: Project, id: string) => findItem(p, id)!.item

describe('freeze frames (E-24)', () => {
  it('freeze at the end holds the clip’s last frame right after it', () => {
    const { p } = separated()
    const q = freezeAtEnd(p, 'va', 3)
    const main = mainTrack(q)!.items
    expect(main.map((i) => [i.start, i.duration])).toEqual([
      [0, 10],
      [10, 3],
      [13, 10],
    ])
    const hold = main[1] as VideoItem
    expect(hold.freezeAt).toBeGreaterThan(9.9)
    expect(hold.freezeAt).toBeLessThan(10)
    // b's separated audio moved with b
    expect(q.tracks.find((t) => t.kind === 'audio')!.items[0].start).toBe(13)
    // a freeze frame has no end of its own to hold
    expect(freezeAtEnd(q, hold.id, 2)).toBe(q)
  })

  it('a freeze frame’s hold can be changed; later clips follow its end', () => {
    const { p, audio } = separated()
    const q = freezeAtEnd(p, 'va', 2)
    const hold = mainTrack(q)!.items[1].id
    const r = setFreezeHold(q, hold, 4.5)
    expect(at(r, hold).duration).toBe(4.5)
    expect(at(r, 'vb').start).toBe(14.5)
    expect(at(r, audio).start).toBe(14.5)
    // only freeze frames take it
    expect(setFreezeHold(q, 'va', 4)).toBe(q)
  })
})
