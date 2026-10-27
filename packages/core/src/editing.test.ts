// Editing ops from the phase 4 pass: locks, freezes, overlaps, speed, paste between projects, canvas-relative text.
import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addItem,
  createProject,
  createTextItem,
  createVideoItem,
  cutSourceRanges,
  deleteItems,
  duplicateItems,
  findItem,
  freezeFrame,
  isEditable,
  mainTrack,
  moveItem,
  separateAudio,
  setKeyframe,
  splitAt,
  splitItem,
  trimItem,
  updateItem,
  updateTrack,
  type Asset,
  type Project,
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

