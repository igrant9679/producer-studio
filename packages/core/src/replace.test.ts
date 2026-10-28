// Replacing a clip's media and splitting at scene changes (E-10).
import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addItem,
  createAudioItem,
  createCaptionItem,
  createProject,
  createTextItem,
  createVideoItem,
  findItem,
  insertTrack,
  itemEnd,
  mainTrack,
  replaceClipMedia,
  replaceRefusal,
  separateAudio,
  setKeyframe,
  splitAtSourceTimes,
  timelineAtSource,
  updateItem,
  type Asset,
  type Project,
  type VideoItem,
} from './index'

const video = (id: string, duration = 10, over: Partial<Asset> = {}): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration, width: 1920, height: 1080, hasAudio: true, ...over })

/** a: 0-10 then b: 10-16 on the main track, a title and two captions. */
function edit(): Project {
  let p = createProject()
  p = addAsset(p, video('a'))
  p = addAsset(p, video('b', 6))
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va', transitionOut: { type: 'crossfade', duration: 0.6 } }))
  p = addItem(p, createVideoItem(p.assets.b, 999, { id: 'vb' }))
  p = addItem(p, createTextItem(2, 'title-serif', { id: 'tt', text: 'Hello', duration: 4 }))
  const c = insertTrack(p, 'caption')
  c.items.push(createCaptionItem(1, 2, 'first line'))
  return p
}

const at = (p: Project, id: string) => findItem(p, id)?.item

describe('replace clip (E-10)', () => {
  it('swaps the media and keeps timing, effects, keyframes and transitions', () => {
    let p = edit()
    p = updateItem<VideoItem>(p, 'va', { in: 2, duration: 6, effects: [{ id: 'fx', type: 'blur', intensity: 40 }] })
    p = setKeyframe(p, 'va', 'scale', 1, 1.5)
    const before = at(p, 'va') as VideoItem
    const r = replaceClipMedia(p, 'va', video('c', 20))
    const after = at(r.project, 'va') as VideoItem
    expect(after.assetId).toBe('c')
    expect(after.name).toBe('c.mp4')
    expect(r.project.assets.c).toBeDefined()
    const { assetId: _a, name: _n, ...keep } = before
    expect(after).toMatchObject(keep)
    expect(r.shortened).toBeFalsy()
  })

  it('moves the source offset back, or shortens the clip, when the new file is shorter', () => {
    let p = updateItem<VideoItem>(edit(), 'va', { in: 3, duration: 6 })
    let after = at(replaceClipMedia(p, 'va', video('c', 7)).project, 'va') as VideoItem
    expect([after.in, after.duration]).toEqual([1, 6])
    const r = replaceClipMedia(p, 'va', video('c', 4))
    after = at(r.project, 'va') as VideoItem
    expect([after.in, after.duration, r.shortened]).toEqual([0, 4, true])
    // the main track closes up
    expect(at(r.project, 'vb')!.start).toBe(4)
    p = r.project
    expect(itemEnd(at(p, 'va')!)).toBe(4)
  })

  it('refuses another kind of media, a locked clip, and the same file', () => {
    const p = edit()
    expect(replaceRefusal(p, 'va', { id: 'x', kind: 'image' })).toBe('kind')
    expect(replaceRefusal(p, 'va', { id: 'a', kind: 'video' })).toBe('same')
    expect(replaceRefusal(updateItem(p, 'va', { locked: true }), 'va', { id: 'c', kind: 'video' })).toBe('locked')
    expect(replaceRefusal(p, 'tt', { id: 'c', kind: 'video' })).toBe('missing')
    expect(replaceClipMedia(p, 'va', { id: 'x', kind: 'image', name: 'x', src: 'x' }).project).toBe(p)
  })

  it('swaps separated audio of the same file with it', () => {
    const p = separateAudio(edit(), 'va')
    const r = replaceClipMedia(p, 'va', video('c', 20))
    expect(r.project.tracks.find((t) => t.kind === 'audio')!.items[0]).toMatchObject({ assetId: 'c' })
    const silent = replaceClipMedia(p, 'va', video('d', 20, { hasAudio: false }))
    expect(silent.project.tracks.find((t) => t.kind === 'audio')!.items[0]).toMatchObject({ assetId: 'a' })
  })

  it('works for audio clips and drops the old voiceover script', () => {
    let p = edit()
    p = addAsset(p, { id: 'm', kind: 'audio', name: 'm.mp3', src: 'm.mp3', duration: 30 })
    p = addItem(p, createAudioItem(p.assets.m, 0, { id: 'au', duration: 5, tts: { text: 'hi', voice: 'af_heart', speed: 1 } }))
    const r = replaceClipMedia(p, 'au', { id: 'n', kind: 'audio', name: 'n.mp3', src: 'n.mp3', duration: 30 })
    expect(at(r.project, 'au')).toMatchObject({ assetId: 'n', duration: 5, tts: undefined })
  })
})

describe('split at scene changes (E-10)', () => {
  it('maps source times into the clip and splits at each', () => {
    let p = updateItem<VideoItem>(edit(), 'va', { in: 2 })
    p = updateItem<VideoItem>(p, 'va', { duration: 8 })
    expect(timelineAtSource(at(p, 'va')!, 5)).toBe(3)
    // 1 is before the clip's in-point, 2.1 too close to its start, 11 past its end
    const r = splitAtSourceTimes(p, 'va', [1, 2.1, 5, 7.5, 11])
    expect(r.count).toBe(2)
    expect(mainTrack(r.project)!.items.filter((i) => (i as VideoItem).assetId === 'a').map((i) => [i.start, i.duration])).toEqual([
      [0, 3],
      [3, 2.5],
      [5.5, 2.5],
    ])
  })

  it('follows speed and reverse', () => {
    const p = updateItem<VideoItem>(edit(), 'va', { speed: 2, duration: 5 })
    expect(timelineAtSource(at(p, 'va')!, 4)).toBe(2)
    const rev = updateItem<VideoItem>(p, 'va', { reverse: true })
    expect(timelineAtSource(at(rev, 'va')!, 4)).toBe(3)
  })
})
