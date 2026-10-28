import { describe, expect, it } from 'vitest'
import {
  VECTOR_TARGETS,
  addAsset,
  addItem,
  createAudioItem,
  createProject,
  createTextItem,
  createVideoItem,
  findItem,
  histogram,
  mainTrack,
  pastableGroups,
  pasteAttributes,
  updateItem,
  vectorscope,
  waveform,
  type Asset,
  type AudioItem,
  type TextItem,
  type VideoItem,
} from './index'

const video = (id: string): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration: 30, width: 1920, height: 1080, hasAudio: true })

function twoClips() {
  let p = createProject()
  p = addAsset(p, video('a'))
  p = addAsset(p, { id: 's', kind: 'audio', name: 's.mp3', src: 's.mp3', duration: 30 })
  p = addItem(p, createVideoItem(p.assets.a, 0, { duration: 4 }))
  p = addItem(p, createVideoItem(p.assets.a, 4, { duration: 6, in: 10 }))
  const [a, b] = mainTrack(p)!.items as VideoItem[]
  p = updateItem<VideoItem>(p, a.id, {
    adjust: { ...a.adjust, contrast: 30 },
    filter: { id: 'teal-orange', intensity: 70 },
    grade: { curves: { master: [[0, 0.05], [1, 0.95]] } },
    effects: [{ id: 'fx1', type: 'grain', intensity: 40 }],
    transform: { x: 100, y: -20, scale: 1.2, rotation: 5, flipX: true },
    opacity: 0.7,
    blend: 'screen',
    keyframes: { x: [{ t: 0, value: 0 }, { t: 1, value: 100 }], volume: [{ t: 0, value: 0.2 }] },
    volume: 0.5,
    fadeIn: 3,
  })
  return { p, a: a.id, b: b.id }
}

describe('paste attributes', () => {
  it('pastes only the groups asked for', () => {
    const { p, a, b } = twoClips()
    const src = findItem(p, a)!.item
    const next = pasteAttributes(p, src, [b], ['colour'])
    const it = findItem(next, b)!.item as VideoItem
    expect(it.adjust.contrast).toBe(30)
    expect(it.filter).toEqual({ id: 'teal-orange', intensity: 70 })
    expect(it.grade).toEqual({ curves: { master: [[0, 0.05], [1, 0.95]] } })
    // nothing else moved
    expect(it.effects).toEqual([])
    expect(it.transform.x).toBe(0)
    expect(it.volume).toBe(1)
  })

  it('pastes effects as copies, the transform with its motion keyframes, and the volume with its fades kept inside the clip', () => {
    const { p, a, b } = twoClips()
    const src = findItem(p, a)!.item
    const next = pasteAttributes(p, src, [b], ['effects', 'transform', 'volume'])
    const it = findItem(next, b)!.item as VideoItem
    expect(it.effects).toHaveLength(1)
    expect(it.effects[0].type).toBe('grain')
    expect(it.effects[0].id).not.toBe('fx1')
    expect(it.transform).toEqual({ x: 100, y: -20, scale: 1.2, rotation: 5, flipX: true })
    expect(it.opacity).toBe(0.7)
    expect(it.blend).toBe('screen')
    expect(it.keyframes.x).toHaveLength(2)
    expect(it.keyframes.volume).toEqual([{ t: 0, value: 0.2 }])
    expect(it.volume).toBe(0.5)
    expect(it.fadeIn).toBe(3)
  })

  it('pastes speed with the clip re-timed, and skips clips that lack the attribute or are locked', () => {
    let { p, a, b } = twoClips()
    p = updateItem<VideoItem>(p, a, { speed: 2, duration: 2 })
    let text = createTextItem(0, 'heading')
    p = addItem(p, text)
    text = p.tracks.flatMap((t) => t.items).find((i) => i.type === 'text') as TextItem
    p = addItem(p, createAudioItem(p.assets.s, 0, { duration: 8 }))
    const audio = p.tracks.flatMap((t) => t.items).find((i) => i.type === 'audio') as AudioItem
    const src = findItem(p, a)!.item
    expect(pastableGroups(src, [findItem(p, text.id)!.item])).toEqual(['effects', 'transform'])
    const next = pasteAttributes(p, src, [b, text.id, audio.id], ['speed', 'colour'])
    const vb = findItem(next, b)!.item as VideoItem
    expect(vb.speed).toBe(2)
    expect(vb.duration).toBe(3)
    expect((findItem(next, audio.id)!.item as AudioItem).speed).toBe(2)
    expect(findItem(next, text.id)!.item).toEqual(findItem(p, text.id)!.item)
    // a locked clip takes nothing
    const locked = updateItem<VideoItem>(p, b, { locked: true })
    expect(findItem(pasteAttributes(locked, src, [b], ['colour']), b)!.item).toEqual(findItem(locked, b)!.item)
  })
})

describe('scopes', () => {
  // two pixels: pure red, mid grey
  const px = new Uint8ClampedArray([255, 0, 0, 255, 128, 128, 128, 255])

  it('counts every level of each channel and of luma', () => {
    const h = histogram(px)
    expect(h.r[255]).toBe(1)
    expect(h.r[128]).toBe(1)
    expect(h.g[0]).toBe(1)
    expect(h.y[54]).toBe(1) // Rec. 709 luma of red
    expect(h.y[128]).toBe(1)
  })

  it('places each column’s luma on the waveform', () => {
    const w = waveform(px, 2, 1, 2, 256)
    expect(w[54 * 2 + 0]).toBe(1)
    expect(w[128 * 2 + 1]).toBe(1)
  })

  it('puts grey in the middle of the vectorscope and red at its target', () => {
    const v = vectorscope(px, 65)
    expect(v[32 * 65 + 32]).toBe(1)
    const red = VECTOR_TARGETS.find((t) => t.name === 'R')!
    const col = Math.round(32 + red.cb * 64)
    const row = Math.round(32 - red.cr * 64)
    expect(v[row * 65 + col]).toBe(1)
  })
})
