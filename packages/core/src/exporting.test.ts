// Phase 5 release 1, playback and export: ranges, reframed presets, caption choices, sidecar files (E-5, E-23),

import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addItem,
  captionTracks,
  createCaptionItem,
  createProject,
  createTextItem,
  createVideoItem,
  evaluate,
  findItem,
  insertTrack,
  itemEnd,
  mainTrack,
  projectDuration,
  projectForExport,
  projectRange,
  selectionRange,
  separateAudio,
  setKeyframe,
  sidecarCaptions,
  updateItem,
  updateTrack,
  type Asset,
  type CaptionItem,
  type Project,
  type VideoItem,
} from './index'

const video = (id: string, duration = 10, over: Partial<Asset> = {}): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration, width: 1920, height: 1080, hasAudio: true, ...over })

/** a: 0-10 then b: 10-16 on the main track, a title 2-6, captions at 1-3 and 8-12. */
function edit(): Project {
  let p = createProject()
  p = addAsset(p, video('a'))
  p = addAsset(p, video('b', 6))
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va', transitionOut: { type: 'crossfade', duration: 0.6 } }))
  p = addItem(p, createVideoItem(p.assets.b, 999, { id: 'vb' }))
  p = addItem(p, createTextItem(2, 'title-serif', { id: 'tt', text: 'Hello', duration: 4 }))
  p = setKeyframe(p, 'tt', 'opacity', 0, 0)
  p = setKeyframe(p, 'tt', 'opacity', 4, 1)
  const c = insertTrack(p, 'caption')
  c.items.push(createCaptionItem(1, 2, 'first line', [{ w: 'first', start: 0, end: 1 }, { w: 'line', start: 1, end: 2 }]), createCaptionItem(8, 4, 'second <line>'))
  return p
}

const at = (p: Project, id: string) => findItem(p, id)?.item

describe('export a range (E-5)', () => {
  it('cuts clips across each end and starts the range at 0', () => {
    const p = edit()
    const r = projectRange(p, 4, 12)
    expect(projectDuration(r)).toBe(8)
    const main = mainTrack(r)!.items as VideoItem[]
    expect(main.map((i) => [i.assetId, i.start, i.duration, i.in])).toEqual([
      ['a', 0, 6, 4],
      ['b', 6, 2, 0],
    ])
    // the transition into b is inside the range and stays
    expect(main[0].transitionOut).toEqual({ type: 'crossfade', duration: 0.6 })
    // the title's keyframes carry on from where the range starts
    const title = r.tracks.flatMap((t) => t.items).find((i) => i.type === 'text')!
    expect([title.start, title.duration]).toEqual([0, 2])
    const opacity = (q: Project, t: number) => evaluate(q, t).layers.find((l) => l.type === 'text')!.opacity
    expect(opacity(r, 1)).toBeCloseTo(opacity(p, 5), 4)
    // the second caption is cut at 12, the first is left out
    const caps = captionTracks(r)[0].items as CaptionItem[]
    expect(caps.map((c) => [c.text, c.start, c.duration])).toEqual([['second <line>', 4, 4]])
    // the original is untouched
    expect(projectDuration(p)).toBe(16)
  })

  it('keeps karaoke words with the part of the line that is exported', () => {
    const r = projectRange(edit(), 2, 16)
    const c = captionTracks(r)[0].items[0] as CaptionItem
    expect([c.start, c.duration, c.words]).toEqual([0, 1, [{ w: 'line', start: 0, end: 1 }]])
  })

  it('cuts locked clips too, and returns the project itself for the whole range', () => {
    const p = edit()
    const locked = updateTrack(p, mainTrack(p)!.id, { locked: true })
    expect(mainTrack(projectRange(locked, 4, 12))!.items.map((i) => i.duration)).toEqual([6, 2])
    expect(projectRange(locked, 0, 16)).toBe(locked)
  })

  it('drops a transition whose next clip is outside the range', () => {
    const r = projectRange(edit(), 0, 10)
    expect((mainTrack(r)!.items[0] as VideoItem).transitionOut).toBeUndefined()
    expect(projectDuration(r)).toBe(10)
  })

  it('cuts separated audio with its video', () => {
    let p = edit()
    p = separateAudio(p, 'va')
    const r = projectRange(p, 3, 8)
    const audio = r.tracks.find((t) => t.kind === 'audio')!.items
    expect(audio.map((i) => [i.start, i.duration, (i as { in: number }).in])).toEqual([[0, 5, 3]])
  })

  it('selection range spans the selected clips', () => {
    expect(selectionRange(edit(), ['tt', 'vb'])).toEqual({ from: 2, to: 16 })
    expect(selectionRange(edit(), [])).toBeUndefined()
  })
})

describe('platform presets and captions (E-5)', () => {
  it('reframes a copy to the preset shape', () => {
    const p = edit()
    const r = projectForExport(p, { aspect: '9:16' })
    expect([r.width, r.height]).toEqual([1080, 1920])
    expect([p.width, p.height]).toEqual([1920, 1080])
    expect(projectForExport(p, { aspect: '16:9' })).toBe(p)
  })

  it('burns in every caption track, one chosen track, or none', () => {
    let p = edit()
    const second = insertTrack(p, 'caption')
    second.items.push(createCaptionItem(0, 1, 'hola'))
    const ids = captionTracks(p).map((t) => t.id)
    expect(captionTracks(projectForExport(p, {})).length).toBe(2)
    expect(captionTracks(projectForExport(p, { captionTrackId: ids[1] })).map((t) => t.id)).toEqual([ids[1]])
    expect(captionTracks(projectForExport(p, { captions: 'sidecar' }))).toEqual([])
    expect(captionTracks(projectForExport(p, { captions: 'none' }))).toEqual([])
    // the burned-in picture has no caption layer once they are left out
    p = projectForExport(p, { captions: 'none' })
    expect(evaluate(p, 1.5).layers.some((l) => l.type === 'caption')).toBe(false)
  })

  it('writes SRT and WebVTT sidecar files from the chosen track', () => {
    const p = edit()
    expect(sidecarCaptions(p, 'srt')).toBe('1\n00:00:01,000 --> 00:00:03,000\nfirst line\n\n2\n00:00:08,000 --> 00:00:12,000\nsecond <line>\n')
    expect(sidecarCaptions(p, 'vtt')).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nfirst line\n\n00:00:08.000 --> 00:00:12.000\nsecond &lt;line&gt;\n')
    // for a range, the times are the exported file's
    expect(sidecarCaptions(projectRange(p, 4, 12), 'srt')).toBe('1\n00:00:04,000 --> 00:00:08,000\nsecond <line>\n')
  })
})
