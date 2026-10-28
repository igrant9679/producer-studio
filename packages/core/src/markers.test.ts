// Markers, snapping to markers and keyframes, and beat detection (E-6).
import { describe, expect, it } from 'vitest'
import { addAsset, addBeatMarkers, addItem, addMarker, createAudioItem, createProject, createVideoItem, detectBeats, nextMarker, removeMarkers, setKeyframe, snapPoints, updateMarker, type Asset } from './index'

const video = (id: string, duration = 10): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration, width: 1920, height: 1080, hasAudio: true })

describe('markers and snapping (E-6)', () => {
  it('markers are added, named, moved, found and removed', () => {
    let p = createProject()
    const a = addMarker(p, 4)
    p = a.project
    expect(addMarker(p, 4.01).id).toBe(a.id)
    p = addMarker(p, 2, { name: 'Intro' }).project
    expect(p.markers!.map((m) => m.t)).toEqual([2, 4])
    p = updateMarker(p, a.id, { name: '  Drop ' })
    expect(p.markers!.find((m) => m.id === a.id)!.name).toBe('Drop')
    p = updateMarker(p, a.id, { t: 7 })
    expect(p.markers!.map((m) => m.t)).toEqual([2, 7])
    expect(nextMarker(p, 2, 1)!.t).toBe(7)
    expect(nextMarker(p, 7, -1)!.t).toBe(2)
    expect(nextMarker(p, 7, 1)).toBeUndefined()
    p = removeMarkers(p, [a.id])
    expect(p.markers!.map((m) => m.t)).toEqual([2])
  })

  it('edits snap to markers and keyframes as well as clip edges and the playhead', () => {
    let p = createProject()
    p = addAsset(p, video('a'))
    p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
    p = setKeyframe(p, 'va', 'opacity', 3.5, 1)
    p = addMarker(p, 6.25).project
    const pts = snapPoints(p, new Set(), 1.5)
    expect(pts).toEqual(expect.arrayContaining([0, 1.5, 3.5, 6.25, 10]))
    // a dragged clip's own keyframes move with it, so they aren't targets
    expect(snapPoints(p, new Set(['va']))).not.toContain(3.5)
  })

  it('beats are found where the loudness jumps', () => {
    const rate = 50
    const values = Array.from({ length: rate * 4 }, (_, k) => {
      const since = k % 25 // a hit every half second, decaying
      return 0.15 + 0.8 * Math.exp(-since / 4)
    })
    const beats = detectBeats(values, rate)
    expect(beats.length).toBeGreaterThanOrEqual(7)
    for (const b of beats) expect(Math.abs(b * 2 - Math.round(b * 2))).toBeLessThan(0.05)
    // a steady tone has none
    expect(detectBeats(Array(200).fill(0.5), rate)).toEqual([])
  })

  it('beat markers land on the timeline where the clip plays those beats', () => {
    let p = createProject()
    const rate = 50
    const waveform = Array.from({ length: rate * 20 }, (_, k) => 0.1 + 0.8 * Math.exp(-(k % 50) / 4))
    p = addAsset(p, { id: 'm', kind: 'audio', name: 'm.mp3', src: 'm.mp3', duration: 20, waveform, waveformRate: rate })
    p = addItem(p, createAudioItem(p.assets.m, 5, { id: 'mu', in: 2, duration: 6 }))
    const r = addBeatMarkers(p, 'mu')
    expect(r.count).toBeGreaterThanOrEqual(5)
    const ts = r.project.markers!.map((m) => m.t)
    expect(ts.every((t) => t >= 5 && t <= 11)).toBe(true)
    // the source beats at 2, 3, 4 s play at 5, 6, 7 s
    expect(ts).toEqual(expect.arrayContaining([5, 6, 7]))
    expect(r.project.markers!.every((m) => m.beat)).toBe(true)
    // running it again replaces them rather than doubling up
    expect(addBeatMarkers(r.project, 'mu').project.markers).toHaveLength(r.project.markers!.length)
    // full peaks passed in (bytes, 1/255) are used instead of the record's
    const bytes = Uint8Array.from(waveform, (v) => Math.round(v * 255))
    expect(addBeatMarkers(p, 'mu', { values: bytes, rate, scale: 1 / 255 }).count).toBe(r.count)
  })
})
