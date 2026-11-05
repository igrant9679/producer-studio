// Music and sound effects for made videos: the composer (huashu-motion's, vendored in scripts/music) gives the same file
// for the same video, at the loudness asked, a different one per style; it runs as its own process; the shipped
// effects (earshot's kits) are all there; and the effects land where the picture moves.
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { MUSIC_STYLES, createProject, createTextItem, createTrack, musicStyleFor } from '@producer/core'
import { composeMusic, STYLES } from '../../scripts/music/soundtrack.js'
import { addSound, composeMusicFile, kitFor, planSfx, sfxCues, sfxManifest, SFX_DIR } from '../ai/soundtrack'
import { ctx } from '../context'
import { probe } from '../media/process'
import { setup } from './helpers'

beforeAll(async () => {
  await setup()
}, 120_000)

const cuts = [
  { id: 'title', t: 0 },
  { id: 's1', t: 2 },
  { id: 's2', t: 5 },
]

describe('the composer', () => {
  it('plays every style the brief offers', () => {
    for (const m of MUSIC_STYLES) expect(STYLES[m.id], m.id).toBeTruthy()
  })

  it('gives the same music for the same video, at the loudness asked, and another for another style', () => {
    const a = composeMusic({ id: 'p1', duration: 7, cuts, style: 'mallet', voiced: true, lufs: -26 })
    const b = composeMusic({ id: 'p1', duration: 7, cuts, style: 'mallet', voiced: true, lufs: -26 })
    expect(a.wav.equals(b.wav)).toBe(true)
    expect(a.lufs).toBeCloseTo(-26, 0)
    // 48 kHz stereo 16-bit, the video's length
    expect(a.wav.readUInt32LE(24)).toBe(48000)
    expect(a.wav.readUInt16LE(22)).toBe(2)
    expect((a.wav.length - 44) / 4 / 48000).toBeCloseTo(7, 2)
    // a section per cut
    expect(a.sections.map((s) => s.id)).toEqual(['title', 's1', 's2'])
    const c = composeMusic({ id: 'p1', duration: 7, cuts, style: 'pulse', voiced: true, lufs: -26 })
    expect(c.wav.equals(a.wav)).toBe(false)
    expect(c.style).toBe('pulse')
  }, 120_000)

  it('runs as its own process and writes AAC', async () => {
    const out = path.join(ctx().config.dataDir, 'music-test.m4a')
    const r = await composeMusicFile({ style: 'ambient', cuts, duration: 6, seed: 'x', out })
    expect(r.about).toMatch(/^ambient/)
    const p = await probe(out)
    expect(p.kind).toBe('audio')
    expect(p.duration).toBeGreaterThan(5.8)
    expect(p.duration).toBeLessThan(6.3)
  }, 120_000)
})

describe('choosing the music', () => {
  it('auto follows the tone; off, absent and unknown mean none', () => {
    expect(musicStyleFor('auto', 'Calm')).toBe('ambient')
    expect(musicStyleFor('auto', 'Confident')).toBe('pulse')
    expect(musicStyleFor('auto', 'quietly playful')).toBe('pizzicato')
    expect(musicStyleFor('auto', 'whatever this is')).toBe('mallet')
    expect(musicStyleFor('lofi', 'Calm')).toBe('lofi')
    expect(musicStyleFor('off', 'Calm')).toBeUndefined()
    expect(musicStyleFor(undefined, 'Calm')).toBeUndefined()
    expect(musicStyleFor('polka', 'Calm')).toBeUndefined()
    expect(kitFor('ambient')).toBe('calm')
    expect(kitFor('pulse')).toBe('launch')
    expect(kitFor(undefined)).toBe('crisp')
  })
})

describe('sound effects', () => {
  it('ships every take its kits name, each with its sync point inside the sound', () => {
    const m = sfxManifest()!
    expect(Object.keys(m.kits).sort()).toEqual(['calm', 'crisp', 'launch', 'minimal'])
    for (const [kit, { roles }] of Object.entries(m.kits)) {
      expect(Object.keys(roles).sort(), kit).toEqual(['click.confirm', 'land', 'pop', 'whoosh.short'])
      for (const r of Object.values(roles)) {
        expect(r.takes.length).toBeGreaterThan(0)
        for (const t of r.takes) {
          expect(fs.existsSync(path.join(SFX_DIR(), t.file)), t.file).toBe(true)
          expect(t.sync).toBeGreaterThanOrEqual(0)
          expect(t.sync).toBeLessThan(t.duration)
        }
      }
    }
  })

  it('a whoosh on each cut, a landing on the title, a few spaced pops per scene away from the cuts, a ding at the close', () => {
    const p = createProject({ id: 'p', name: 'x', width: 1920, height: 1080, fps: 30 })
    const cards = createTrack('text', { name: 'Headlines' })
    cards.items.push(createTextItem(0.25, 'heading', { name: 'Title', animations: { in: { preset: 'rise', duration: 0.6 } } }))
    cards.items.push(createTextItem(10.3, 'heading', { name: 'Close', animations: { in: { preset: 'slideUp', duration: 0.6 } } }))
    const graphics = createTrack('text', { name: 'Graphic text 1' })
    // 3.1 is on the cut at 3; 3.6, 3.8 too close together; five in the first scene, only three heard
    for (const at of [3.1, 3.6, 3.8, 4.4, 5.0, 5.6, 7.0]) graphics.items.push(createTextItem(at, 'heading', { animations: { in: { preset: 'fade', duration: 0.3 } } }))
    p.tracks.push(cards, graphics)
    const spans = [
      { id: 's1', start: 3, end: 6.5 },
      { id: 's2', start: 6.5, end: 10 },
    ]
    const cues = sfxCues(p, spans, 10)
    expect(cues.map((c) => `${c.moment}@${c.at}`)).toEqual(['title@0.25', 'cut@3', 'appear@3.6', 'appear@4.4', 'appear@5', 'cut@6.5', 'appear@7', 'cut@10', 'close@10.7'])
    const m = sfxManifest()!
    const plan = planSfx(cues, 'launch', m)
    const whoosh = m.kits.launch.roles['whoosh.short']
    // the whoosh peaks where the kit says, against the cut (a little after it); takes in turn
    const onCuts = plan.filter((e) => e.cue.moment === 'cut')
    for (const e of onCuts) expect(Math.abs(e.start + e.take.sync - e.cue.at - 0.037)).toBeLessThanOrEqual(0.0011)
    expect(new Set(onCuts.map((e) => e.take.file)).size).toBe(Math.min(3, whoosh.takes.length))
    expect(plan.every((e) => e.start >= 0 && e.volume > 0 && e.volume <= 1)).toBe(true)
    // a cue whose sound would start before the video does is dropped, not moved
    expect(planSfx([{ moment: 'cut', at: 0 }], 'launch', m)).toEqual([])
  })

  it('with no cards: no whoosh into a close that isn’t there, and one on the first cut would start too early', () => {
    const p = createProject({ id: 'p', name: 'x', width: 1920, height: 1080, fps: 30 })
    const cues = sfxCues(p, [{ id: 's1', start: 0, end: 4 }, { id: 's2', start: 4, end: 8 }])
    expect(cues).toEqual([{ moment: 'cut', at: 0 }, { moment: 'cut', at: 4 }])
    expect(planSfx(cues, 'launch', sfxManifest()!).map((e) => e.cue.at)).toEqual([4])
  })

  it('music with no voice to duck under has no duck', () => {
    const p = createProject({ id: 'p', name: 'x', width: 1920, height: 1080, fps: 30 })
    const out = addSound(p, { music: { id: 'as_m', kind: 'audio', name: 'Music', duration: 20 } as never }, 18)
    expect(out.tracks.find((t) => t.name === 'Music')!.duck).toBeUndefined()
  })

  it('adds the music under the voice and the effects on their own track', () => {
    const p = createProject({ id: 'p', name: 'x', width: 1920, height: 1080, fps: 30 })
    const voice = createTrack('audio', { name: 'Voiceover' })
    p.tracks.unshift(voice)
    const song = { id: 'as_m', kind: 'audio', name: 'Music', duration: 20 } as never
    const pop = { id: 'as_p', kind: 'audio', name: 'pop', duration: 0.2 } as never
    const out = addSound(p, { music: song, effects: [{ asset: pop, start: 1, volume: 0.4, name: 'appear sound' }] }, 18)
    expect(out.tracks.map((t) => t.name).slice(0, 3)).toEqual(['Voiceover', 'Music', 'Sound effects'])
    expect(out.tracks[1]).toMatchObject({ duck: 10, items: [{ start: 0, duration: 18, fadeOut: 1.2 }] })
    expect(out.tracks[2].items[0]).toMatchObject({ start: 1, volume: 0.4, duration: 0.2 })
    expect(Object.keys(out.assets).sort()).toEqual(['as_m', 'as_p'])
  })
})
