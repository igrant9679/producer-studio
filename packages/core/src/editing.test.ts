// Editing ops from the phase 4 pass: locks, freezes, overlaps, speed, paste between projects, canvas-relative text.
import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addItem,
  clone,
  createImageItem,
  createProject,
  createTextItem,
  createVideoItem,
  cutSourceRanges,
  deleteItems,
  duplicateItems,
  evaluate,
  findItem,
  freezeFrame,
  insertTrack,
  isEditable,
  itemEnd,
  mainTrack,
  moveItem,
  separateAudio,
  separateAudioRefusal,
  setKeyframe,
  splitAt,
  splitItem,
  trimItem,
  updateItem,
  updateTrack,
  type Asset,
  type Item,
  type Project,
  type Track,
  type VideoItem,
} from './index'

const video = (id: string, duration = 10): Asset => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  src: `${id}.mp4`,
  duration,
  width: 1920,
  height: 1080,
  hasAudio: true,
  transcript: { language: 'en', engine: 'test', segments: [{ start: 0, end: 2, text: 'one two', words: [{ w: 'one', start: 0.2, end: 0.6 }, { w: 'two', start: 1, end: 1.4 }] }] },
})

/** Two clips on the main track (a: 0-10, b: 10-16). */
function twoClips(): Project {
  let p = createProject()
  p = addAsset(p, video('a'))
  p = addAsset(p, video('b', 6))
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
  return addItem(p, createVideoItem(p.assets.b, 999, { id: 'vb' }))
}

const item = (p: Project, id: string) => findItem(p, id)!.item
const lockMain = (p: Project) => updateTrack(p, mainTrack(p)!.id, { locked: true })

describe('locks (EDT-19)', () => {
  it('a locked track refuses every op on its clips', () => {
    const p = lockMain(twoClips())
    expect(isEditable(p, 'va')).toBe(false)
    expect(splitItem(p, 'va', 4).project).toBe(p)
    expect(splitAt(p, 4)).toBe(p)
    expect(trimItem(p, 'va', 'end', 5)).toBe(p)
    expect(trimItem(p, 'va', 'start', 2)).toBe(p)
    expect(moveItem(p, 'va', { start: 20 })).toBe(p)
    expect(updateItem(p, 'va', { opacity: 0.5 })).toBe(p)
    expect(setKeyframe(p, 'va', 'opacity', 1, 0.5)).toBe(p)
    expect(deleteItems(p, ['va'])).toBe(p)
    expect(duplicateItems(p, ['va']).project).toBe(p)
    expect(separateAudio(p, 'va')).toBe(p)
    expect(freezeFrame(p, 'va', 4)).toBe(p)
    expect(cutSourceRanges(p, 'va', [{ start: 0.2, end: 0.6 }])).toBe(p)
  })

  it('a locked item refuses edits but can still be unlocked', () => {
    const p = updateItem(twoClips(), 'va', { locked: true })
    expect(item(p, 'va').locked).toBe(true)
    expect(updateItem(p, 'va', { opacity: 0.5 })).toBe(p)
    expect(splitItem(p, 'va', 4).project).toBe(p)
    expect(deleteItems(p, ['va'])).toBe(p)
    const q = updateItem(p, 'va', { locked: false })
    expect(isEditable(q, 'va')).toBe(true)
  })

  it('deleting a mix of locked and unlocked clips removes only the unlocked ones', () => {
    let p = addItem(twoClips(), createTextItem(0, 'heading', { id: 'title' }))
    p = lockMain(p)
    const q = deleteItems(p, ['va', 'title'])
    expect(findItem(q, 'va')).toBeTruthy()
    expect(findItem(q, 'title')).toBeNull()
  })

  it('nothing new lands on a locked track: it goes to a free one', () => {
    let p = addItem(twoClips(), createTextItem(0, 'heading', { id: 'title' }))
    const textTrack = findItem(p, 'title')!.track.id
    p = updateTrack(p, textTrack, { locked: true })
    const q = addItem(p, createTextItem(5, 'heading', { id: 'second' }), textTrack)
    expect(findItem(q, 'second')!.track.id).not.toBe(textTrack)
    expect(findItem(q, 'second')!.track.locked).toBeFalsy()
  })

  it('a split leaves linked audio on a locked track whole', () => {
    let p = separateAudio(twoClips(), 'va')
    const audio = p.tracks.find((t) => t.kind === 'audio')!
    p = updateTrack(p, audio.id, { locked: true })
    const q = splitItem(p, 'va', 4).project
    expect(q.tracks.find((t) => t.kind === 'audio')!.items).toHaveLength(1)
    expect(mainTrack(q)!.items).toHaveLength(3)
  })
})

/** Two clips back to back on an overlay track (o1: 0-4, o2: 4-8) above the main track. */
function overlayPair(): Project {
  const p = clone(twoClips())
  const ov = insertTrack(p, 'overlay')
  let q = addItem(p, createVideoItem(p.assets.a, 0, { id: 'o1', duration: 4 }), ov.id)
  q = addItem(q, createVideoItem(q.assets.a, 4, { id: 'o2', duration: 4, in: 4 }), ov.id)
  return q
}

const overlapping = (t: Track) => t.items.some((a, i) => t.items.some((b, j) => i !== j && a.start < itemEnd(b) - 1e-6 && itemEnd(a) > b.start + 1e-6))

describe('clips on overlay tracks never overlap (EDT-15)', () => {
  it('an edge trim stops at the neighbouring clip', () => {
    const p = overlayPair()
    expect(findItem(p, 'o1')!.track.id).toBe(findItem(p, 'o2')!.track.id)
    expect(itemEnd(item(trimItem(p, 'o1', 'end', 7), 'o1'))).toBe(4)
    const q = trimItem(p, 'o2', 'start', 1)
    expect(item(q, 'o2').start).toBe(4)
    expect((item(q, 'o2') as VideoItem).in).toBe(4)
    // shortening still works
    expect(itemEnd(item(trimItem(p, 'o1', 'end', 3), 'o1'))).toBe(3)
  })

  it('a clip slowed down past its neighbour moves to a free track', () => {
    const p = overlayPair()
    const q = updateItem<VideoItem>(p, 'o1', { speed: 0.5, duration: 8 })
    expect(findItem(q, 'o1')!.track.id).not.toBe(findItem(q, 'o2')!.track.id)
    expect(findItem(q, 'o1')!.track.kind).toBe('overlay')
    expect(q.tracks.some(overlapping)).toBe(false)
    expect(item(q, 'o2').start).toBe(4)
  })
})

describe('trim below zero (EDT-35)', () => {
  it('clamps the start to 0 before working out the source offset', () => {
    const p = clone(twoClips())
    const ov = insertTrack(p, 'overlay')
    const q = addItem(p, createVideoItem(p.assets.a, 5, { id: 'late', duration: 2, in: 8 }), ov.id)
    const r = trimItem(q, 'late', 'start', -1)
    expect(item(r, 'late').start).toBe(0)
    // the frame at the old start (source 8 at time 5) is still at time 5
    expect((item(r, 'late') as VideoItem).in).toBe(3)
    expect(item(r, 'late').duration).toBe(7)
  })
})

describe('separate audio (EDT-21)', () => {
  it('refuses a clip whose audio is already separated, so no second copy plays on top', () => {
    const p = separateAudio(twoClips(), 'va')
    expect(separateAudioRefusal(p, 'va')).toBe('separated')
    expect(separateAudio(p, 'va')).toBe(p)
    expect(p.tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.items)).toHaveLength(1)
  })

  it('refuses a freeze frame and a reversed clip, which play no sound', () => {
    const frozen = freezeFrame(twoClips(), 'va', 4)
    const hold = mainTrack(frozen)!.items.find((i) => (i as VideoItem).freezeAt !== undefined)!
    expect(separateAudio(frozen, hold.id)).toBe(frozen)
    expect(separateAudioRefusal(frozen, hold.id)).toBe('freeze')
    const reversed = updateItem<VideoItem>(twoClips(), 'va', { reverse: true })
    expect(separateAudio(reversed, 'va')).toBe(reversed)
  })

  it('still separates the right half of a split clip whose left half was separated', () => {
    const p = splitItem(separateAudio(twoClips(), 'va'), 'va', 4).project
    // the split cut the linked audio too, so both halves already have theirs
    const right = mainTrack(p)!.items[1]
    expect(separateAudioRefusal(p, right.id)).toBe('separated')
    expect(separateAudioRefusal(p, 'vb')).toBeNull()
  })
})

describe('effects run on through a split (EDT-34)', () => {
  const still: Asset = { id: 'img', kind: 'image', name: 'still.png', src: 'still.png', width: 1920, height: 1080 }
  function moving(): Project {
    const p = addAsset(createProject(), still)
    const img = createImageItem(still, 0, {
      id: 'm1',
      duration: 6,
      effects: [{ id: 'fx1', type: 'kenBurns', intensity: 80 }, { id: 'fx2', type: 'zoomPulse', intensity: 60 }, { id: 'fx3', type: 'flash', intensity: 50 }],
      animations: { combo: { preset: 'float', period: 1.7 } },
    })
    return addItem(p, img)
  }
  const look = (p: Project, t: number) => {
    const l = evaluate(p, t).layers[0]
    return { transform: l.transform, cx: l.box.cx, cy: l.box.cy, filter: l.filter }
  }

  it('Ken Burns, loops, flashes and zoom pulses look the same after a cut as before it', () => {
    const p = moving()
    const q = splitItem(p, 'm1', 2.3).project
    for (const t of [0.4, 2.0, 2.31, 3.1, 4.75, 5.9]) expect(look(q, t)).toEqual(look(p, t))
  })

  it('and still after the right piece is trimmed or split again', () => {
    const p = moving()
    const { project: q, rightId } = splitItem(p, 'm1', 2.3)
    const r = splitItem(q, rightId!, 4).project
    for (const t of [3.1, 4.2, 5.5]) expect(look(r, t)).toEqual(look(p, t))
    // on an overlay track a start trim leaves the piece where it is in time
    const ov = clone(p)
    const track = insertTrack(ov, 'overlay')
    const lifted = moveItem(ov, 'm1', { start: 0, trackId: track.id })
    const cut = splitItem(lifted, 'm1', 2.3)
    const trimmed = trimItem(cut.project, cut.rightId!, 'start', 3)
    expect(item(trimmed, cut.rightId!).start).toBe(3)
    for (const t of [3.2, 4.4]) expect(look(trimmed, t)).toEqual(look(lifted, t))
  })
})

describe('freeze at a clip edge (EDT-11)', () => {
  const tag = (i: Item) => ((i as VideoItem).freezeAt !== undefined ? 'hold' : i.id)
  const order = (p: Project) => mainTrack(p)!.items.map((i) => [tag(i), i.start, i.duration])

  it('at the start of a clip the hold goes before it, showing its first frame', () => {
    const q = freezeFrame(twoClips(), 'vb', 10.01)
    expect(order(q)).toEqual([['va', 0, 10], ['hold', 10, 2], ['vb', 12, 6]])
    expect((mainTrack(q)!.items[1] as VideoItem).freezeAt).toBeCloseTo(0.01, 3)
  })

  it('at the very end it goes after the clip', () => {
    const q = freezeFrame(twoClips(), 'va', 9.99)
    expect(order(q)).toEqual([['va', 0, 10], ['hold', 10, 2], ['vb', 12, 6]])
  })

  it('on an overlay track the clip and everything after it make room', () => {
    const q = freezeFrame(overlayPair(), 'o1', 0.01)
    expect(findItem(q, 'o1')!.track.items.map((i) => [tag(i), i.start])).toEqual([['hold', 0], ['o1', 2], ['o2', 6]])
  })
})
