import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { addAsset, addItem, createAudioItem, createProject, createTextItem, createVideoItem, exportVideoTiming, generateCaptions, mainTrack, type Project } from '@producer/core'
import { buildProducerTimeline, syntheticTranscript } from '../ai/produce'
import { assetDoc } from '../dto'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { probe, processAsset } from '../media/process'
import { lintComposition, parseRenderProgress, prepareRenderDir, renderArgs, renderWorkers, targetSize } from '../render/export'

// every ffmpeg call still runs; the spy shows how the reversed copies are made
vi.mock('../media/proc', async (importOriginal) => {
  const m = await importOriginal<typeof import('../media/proc')>()
  return { ...m, ffmpeg: vi.fn(m.ffmpeg) }
})
import { createAssetFromFile } from '../services/assets'
import { setup, signup } from './helpers'

let workspaceId: string
let userId: string
let project: Project
let videoId: string
let freezeItemId: string

/** One frame of `file` at `t`, as 64×36 grey bytes. */
async function gray(file: string, t: number, dir: string): Promise<Buffer> {
  const out = path.join(dir, `frame-${Math.random().toString(36).slice(2)}.gray`)
  await ffmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'gray', out])
  return fs.readFileSync(out)
}

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

  it('reverses a clip in short chunks at the output size, padded for its pre-roll (PIP-4, PIP-5)', async () => {
    const a = project.assets[videoId]
    let p = createProject({ name: 'Reverse', width: 1280, height: 720 })
    p = addAsset(p, a)
    p = addItem(p, createVideoItem(a, 0, { duration: 1.5, transitionOut: { type: 'crossfade', duration: 1 } }))
    // source 0..2 backwards; the 1 s of source after it is there to pre-roll into the crossfade
    p = addItem(p, createVideoItem(a, 1.5, { duration: 2, reverse: true }))
    const track = mainTrack(p)!
    const rev = track.items[1]
    const timing = exportVideoTiming(p, p.tracks.indexOf(track), 1)
    expect(timing.reversed).toEqual({ from: 0, to: 2.5 })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-render-'))
    vi.mocked(ffmpeg).mockClear()
    await prepareRenderDir(p, workspaceId, dir, { output: { w: 320, h: 180 }, fps: 30 })
    const copy = path.join(dir, 'reversed', `${rev.id}.mp4`)
    const info = await probe(copy)
    expect({ w: info.width, h: info.height }).toEqual({ w: 320, h: 180 })
    expect(info.duration).toBeCloseTo(2.5, 1)
    // each reverse holds at most 2 s of decoded frames, never the whole clip
    const reverses = vi.mocked(ffmpeg).mock.calls.map((c) => c[0]).filter((args) => /reverse/.test(args[args.indexOf('-vf') + 1] ?? ''))
    expect(reverses.length).toBeGreaterThan(1)
    for (const args of reverses) expect(Number(args[args.indexOf('-t') + 1])).toBeLessThanOrEqual(2)
    // the copy runs the source backwards from 2.5 s, across the chunk joins
    const src = path.join(dir, 'assets', `${videoId}.mp4`)
    const frame = (file: string, t: number) => gray(file, t, dir)
    const diff = (x: Buffer, y: Buffer) => x.reduce((n, v, i) => n + Math.abs(v - y[i]), 0) / x.length
    for (const k of [3, 30, 59, 61]) {
      const f = (k + 0.5) / 30
      const shown = await frame(copy, f)
      const same = await frame(src, 2.5 - (k + 1) / 30 + 0.5 / 30)
      const other = await frame(src, 2.5 - (k + 6) / 30 + 0.5 / 30)
      expect(diff(shown, same)).toBeLessThan(diff(shown, other))
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('extracts the frame a clip holds before its file starts (PIP-5 / EDT-3)', async () => {
    const a = project.assets[videoId]
    let p = createProject({ name: 'Hold', width: 1280, height: 720 })
    p = addAsset(p, a)
    p = addItem(p, createVideoItem(a, 0, { duration: 2, transitionOut: { type: 'crossfade', duration: 1 } }))
    p = addItem(p, createVideoItem(a, 2, { duration: 2 })) // from the source's first frame: nothing to pre-roll
    const b = mainTrack(p)!.items[1]
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-render-'))
    const prep = await prepareRenderDir(p, workspaceId, dir)
    expect(fs.existsSync(path.join(dir, 'stills', `${b.id}-hold.png`))).toBe(true)
    const html = fs.readFileSync(prep.index, 'utf8')
    expect(html).toContain(`<img data-ps-hold="2" src="stills/${b.id}-hold.png"`)
    const lint = await lintComposition(dir)
    expect(lint.errors).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses media from another workspace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-render-'))
    await expect(prepareRenderDir(project, 'ws_other', dir)).rejects.toThrow(/not in this workspace/)
  })

  it('gives each export its share of the machine instead of all of it (PIP-19)', () => {
    // 8 GB, 8 cores, two job slots: HyperFrames alone starts 2 Chrome workers per export, 4 for two at once
    expect(renderWorkers({ memoryMb: 8192, cpus: 8, concurrency: 2, frames: 900 })).toBe(1)
    expect(renderWorkers({ memoryMb: 32768, cpus: 16, concurrency: 2, frames: 900 })).toBe(5)
    expect(renderWorkers({ memoryMb: 32768, cpus: 4, concurrency: 1, frames: 900 })).toBe(2)
    expect(renderWorkers({ memoryMb: 32768, cpus: 16, concurrency: 1, frames: 45 })).toBe(1)
    const args = renderArgs('dir', 'out.mp4', { fps: 30, quality: 'standard', format: 'mp4', workers: 3 })
    expect(args.slice(args.indexOf('--workers'), args.indexOf('--workers') + 2)).toEqual(['--workers', '3'])
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
