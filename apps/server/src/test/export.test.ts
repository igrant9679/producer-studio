import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { addAsset, addItem, createAudioItem, createProject, createTextItem, createVideoItem, generateCaptions, type Project } from '@producer/core'
import { buildProducerTimeline, syntheticTranscript } from '../ai/produce'
import { assetDoc } from '../dto'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { processAsset } from '../media/process'
import { lintComposition, parseRenderProgress, prepareRenderDir, targetSize } from '../render/export'
import { createAssetFromFile } from '../services/assets'
import { setup, signup } from './helpers'

let workspaceId: string
let userId: string
let project: Project
let videoId: string
let freezeItemId: string

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app)
  workspaceId = u.workspaceId
  userId = (await u.client.json('GET', '/api/auth/me')).body.user.id
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-exp-'))
  const file = path.join(tmp, 'clip.mp4')
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file])
  const created = await createAssetFromFile({ workspaceId, userId, filePath: file, name: 'clip.mp4', mime: 'video/mp4', kind: 'video', origin: 'upload' })
  const row = await processAsset(created.id, inlineContext({ id: 't', kind: 'asset.process', workspaceId, userId, projectId: null, input: {} }))
  videoId = row.id
  const a = assetDoc(row)
  expect(a.proxySrc).toBeDefined()
  expect(a.filmstrip?.frames).toBe(10)
  expect(a.waveform!.length).toBeGreaterThan(100)
  let p = createProject({ name: 'Compile test', width: 1280, height: 720 })
  p = addAsset(p, { ...a, transcript: syntheticTranscript('Testing the export compile path.', 3) })
  p = addItem(p, createVideoItem(a, 0, { duration: 2, transitionOut: { type: 'crossfade', duration: 0.4 } }))
  const freeze = createVideoItem(a, 2, { duration: 1, freezeAt: 1.5, muted: true })
  freezeItemId = freeze.id
  p = addItem(p, freeze)
  p = addItem(p, createAudioItem(a, 0.2, { duration: 2.5 }))
  p = addItem(p, createTextItem(0.1, 'title-serif', { text: 'Compile', duration: 2 }))
  project = generateCaptions(p)
})

describe('export compile', () => {
  it('writes index.html, runtime, gsap, fonts, media and freeze stills into the render dir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-render-'))
    const prep = await prepareRenderDir(project, workspaceId, dir)
    const must = ['index.html', 'runtime.js', 'gsap.min.js', `assets/${videoId}.mp4`, `stills/${freezeItemId}.png`]
    for (const f of must) expect(fs.existsSync(path.join(dir, f)), f).toBe(true)
    const fonts = fs.readdirSync(path.join(dir, 'fonts'))
    expect(fonts.some((f) => f.startsWith('playfair-display-latin-700-italic'))).toBe(true)
    expect(fonts.some((f) => f.startsWith('inter-latin-'))).toBe(true)
    const html = fs.readFileSync(prep.index, 'utf8')
    expect(html).toContain('data-composition-id="main"')
    expect(html).toContain(`src="assets/${videoId}.mp4"`)
    expect(html).toContain(`stills/${freezeItemId}.png`)
    expect(html).toContain("font-family:'Playfair Display'")
    expect(html).toContain('window.__timelines')
    const runtime = fs.readFileSync(path.join(dir, 'runtime.js'), 'utf8')
    expect(runtime).toContain('ProducerRuntime')
    expect(prep.duration).toBe(3)
    const lint = await lintComposition(dir)
    expect(lint.errors).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses media from another workspace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-render-'))
    await expect(prepareRenderDir(project, 'ws_other', dir)).rejects.toThrow(/not in this workspace/)
  })

  it('targetSize and progress parsing', () => {
    expect(targetSize(1920, 1080, '720p')).toEqual({ w: 1280, h: 720 })
    expect(targetSize(1080, 1920, '1080p')).toEqual({ w: 1080, h: 1920 })
    expect(targetSize(1920, 1080, '4k')).toEqual({ w: 3840, h: 2160 })
    expect(parseRenderProgress('  ████░░░  64%  Streaming frame 180/281')).toBeCloseTo(0.64)
    expect(parseRenderProgress('{"totalFrames":200,"framesCompleted":50}')).toBeCloseTo(0.25)
    expect(parseRenderProgress('nothing here')).toBeUndefined()
  })

  it('buildProducerTimeline follows the house timing rules', () => {
    const a = project.assets[videoId]
    const voice = { id: 'as_vo', kind: 'audio' as const, name: 'vo', src: '', duration: 2, transcript: syntheticTranscript('This is scene one.', 2) }
    const p = buildProducerTimeline({
      project: createProject({ id: 'p_x', name: 'Prod' }),
      brief: { title: 'Prod test', audience: 'Team', goal: 'Show it', tone: 'warm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' },
      scenes: [
        { id: 's01', title: 'Hook', headline: 'One place', narration: 'This is scene one.', footage: [{ assetId: videoId, start: 0, end: 3 }] },
        { id: 's02', title: 'Close', headline: 'Thanks', narration: 'This is scene one.', footage: [] },
      ],
      footage: new Map([[videoId, a]]),
      voices: new Map([
        ['s01', { asset: voice, duration: 2 }],
        ['s02', { asset: { ...voice, id: 'as_vo2' }, duration: 2 }],
      ]),
    })
    const main = p.tracks.find((t) => t.main)!
    // title card 3 s, scene 1 = 2 + 0.5 + 1.4 = 3.9, scene 2 (close) = 2 + 0.5 + 1.8 = 4.3, close card 3.5
    expect(p.width).toBe(1920)
    expect(main.items[0]).toMatchObject({ type: 'shape', start: 0, duration: 3 })
    const s1 = main.items.filter((i) => i.name?.startsWith('s01'))
    expect(s1.reduce((n, i) => n + i.duration, 0)).toBeCloseTo(3.9, 3)
    // 3 s of footage for a 3.9 s scene → slowed to fill (≥ 60 % coverage), no hold needed
    expect((s1[0] as { speed: number }).speed).toBeCloseTo(3 / 3.9, 2)
    const voiceTrack = p.tracks.find((t) => t.kind === 'audio')!
    expect(voiceTrack.items[0].start).toBeCloseTo(3.5, 3)
    expect(voiceTrack.items[1].start).toBeCloseTo(3 + 3.9 + 0.5, 3)
    expect(p.tracks.some((t) => t.kind === 'caption' && t.items.length > 0)).toBe(true)
    expect(p.background).toBe('#0b1830')
  })
})
