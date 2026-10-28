// Linked groups (E-1): a video and its separated audio split, trim, move and delete together.
import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addItem,
  createAudioItem,
  createProject,
  createVideoItem,
  cutSourceRanges,
  deleteItems,
  duplicateItems,
  findItem,
  insertTrack,
  isLinkedGroup,
  itemEnd,
  linkItems,
  linkedPartners,
  mainTrack,
  moveLinked,
  pasteItems,
  separateAudio,
  splitItem,
  trimLinked,
  unlinkItems,
  withLinked,
  type Asset,
  type Project,
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
  transcript: { language: 'en', engine: 'test', segments: [{ start: 0, end: 4, text: 'one two', words: [{ w: 'one', start: 1, end: 2 }, { w: 'two', start: 3, end: 4 }] }] },
})

/** a (0-10) and b (10-20) on the main track, b's sound separated onto an audio track. */
function separated(): { p: Project; audio: string } {
  let p = createProject()
  p = addAsset(p, video('a'))
  p = addAsset(p, video('b'))
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
  p = addItem(p, createVideoItem(p.assets.b, 99, { id: 'vb' }))
  p = separateAudio(p, 'vb')
  const audio = p.tracks.find((t) => t.kind === 'audio')!.items[0].id
  return { p, audio }
}

const at = (p: Project, id: string) => findItem(p, id)!.item

describe('linked groups (E-1)', () => {
  it('the partners of a separated clip, and a selection grown to its groups', () => {
    const { p, audio } = separated()
    expect(linkedPartners(p, 'vb').map((x) => x.item.id)).toEqual([audio])
    expect(withLinked(p, ['vb'])).toEqual(['vb', audio])
    expect(withLinked(p, ['va'])).toEqual(['va'])
    expect(isLinkedGroup(p, ['vb', audio])).toBe(true)
    expect(isLinkedGroup(p, ['va', 'vb'])).toBe(false)
  })

  it('dragging the separated audio moves its main-track clip, and the audio stays under it', () => {
    const { p, audio } = separated()
    // a small nudge: the magnetic main track keeps b where it is, so the audio can't drift out of sync
    const nudged = moveLinked(p, audio, { start: 11 })
    expect(at(nudged, audio).start).toBe(10)
    expect(at(nudged, 'vb').start).toBe(10)
    // to the start, before a: both move to 0
    const moved = moveLinked(p, audio, { start: 0 })
    expect(at(moved, 'vb').start).toBe(0)
    expect(at(moved, audio).start).toBe(0)
    expect(at(moved, 'va').start).toBe(10)
  })

  it('a linked overlay clip and its audio move together whichever is dragged', () => {
    let p = createProject()
    p = addAsset(p, video('a'))
    const ov = insertTrack(p, 'overlay')
    p = addItem(p, createVideoItem(p.assets.a, 5, { id: 'ov' }), ov.id)
    p = addItem(p, createAudioItem(p.assets.a, 5, { id: 'au', duration: 10 }))
    p = linkItems(p, ['ov', 'au'])
    const q = moveLinked(p, 'au', { start: 8 })
    expect(at(q, 'au').start).toBe(8)
    expect(at(q, 'ov').start).toBe(8)
  })

  it('trimming either clip of a group trims the edge they share, on both', () => {
    const { p, audio } = separated()
    const end = trimLinked(p, audio, 'end', 17)
    expect(itemEnd(at(end, audio))).toBe(17)
    expect(itemEnd(at(end, 'vb'))).toBe(17)
    // the start of the main-track clip: the track re-packs and the audio follows, starting at the same source frame
    const start = trimLinked(p, 'vb', 'start', 12)
    const v = at(start, 'vb') as VideoItem
    const a = at(start, audio) as VideoItem
    expect([v.start, v.duration, v.in]).toEqual([10, 8, 2])
    expect([a.start, a.duration, a.in]).toEqual([10, 8, 2])
    // and from the audio's side
    const fromAudio = trimLinked(p, audio, 'start', 13)
    expect([at(fromAudio, 'vb').start, (at(fromAudio, 'vb') as VideoItem).in, at(fromAudio, audio).start, (at(fromAudio, audio) as VideoItem).in]).toEqual([10, 3, 10, 3])
  })

  it('a partner whose edge is elsewhere (a J or L cut) keeps it', () => {
    const { p, audio } = separated()
    // shorten only the audio first (as a J/L-cut trim does), then trim the video's end: the audio's end stays
    const short = trimLinked(unlinkItems(p, [audio]), audio, 'end', 16)
    const relinked = linkItems(short, ['vb', audio])
    const v = trimLinked(relinked, 'vb', 'end', 19)
    expect(itemEnd(at(v, 'vb'))).toBe(19)
    expect(itemEnd(at(v, audio))).toBe(16)
  })

  it('a split cuts the whole group, and a transcript cut on the audio takes the same stretch of the video', () => {
    const { p, audio } = separated()
    const { project, rightId } = splitItem(p, audio, 15)
    expect(rightId).toBeTruthy()
    expect(mainTrack(project)!.items).toHaveLength(3)
    // cut source 1-2 s ("one") out of the audio: the video loses it too and both stay in step
    const cut = cutSourceRanges(p, audio, [{ start: 1, end: 2 }])
    const main = mainTrack(cut)!.items
    const sound = cut.tracks.find((t) => t.kind === 'audio')!.items
    expect(main.reduce((n, i) => n + i.duration, 0)).toBeCloseTo(19, 4)
    expect(sound.map((i) => [i.start, i.duration])).toEqual(main.filter((i) => i.id !== 'va').map((i) => [i.start, i.duration]))
  })

  it('link, unlink, and copies that stay linked to each other', () => {
    const { p, audio } = separated()
    const u = unlinkItems(p, [audio])
    expect(at(u, audio).linkId).toBeUndefined()
    // the group is gone: the video is left with no partner, so no link either
    expect(at(u, 'vb').linkId).toBeUndefined()
    const l = linkItems(u, ['vb', audio])
    expect(at(l, 'vb').linkId).toBeTruthy()
    expect(at(l, 'vb').linkId).toBe(at(l, audio).linkId)
    // one item can't be linked
    expect(linkItems(u, ['vb'])).toBe(u)
    const dup = duplicateItems(p, ['vb', audio])
    const [cv, ca] = dup.newIds.map((id) => at(dup.project, id))
    expect(cv.linkId).toBeTruthy()
    expect(cv.linkId).toBe(ca.linkId)
    expect(cv.linkId).not.toBe(at(p, 'vb').linkId)
    // a copy without its partner is linked to nothing
    const one = pasteItems(p, [at(p, audio)], 30)
    expect(at(one.project, one.newIds[0]).linkId).toBeUndefined()
  })

  it('deleting the group removes the video and its audio', () => {
    const { p, audio } = separated()
    const d = deleteItems(p, withLinked(p, ['vb']))
    expect(findItem(d, 'vb')).toBeNull()
    expect(findItem(d, audio)).toBeNull()
  })
})
