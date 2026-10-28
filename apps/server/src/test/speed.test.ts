// Speed (E-17) on the server: the smooth slow-motion job (media.smooth) and its route, the pitch-shifted copies the
// export plays, and what a ramped, smoothed, pitch-shifted clip puts in the composition.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { addAsset, addItem, applyRampPreset, applySmoothCopy, createProject, createVideoItem, findItem, mainTrack, setItemSpeed, setPitchShift, setSmoothJob, smoothRange, type VideoItem } from '@producer/core'
import { assetDoc } from '../dto'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { probe, processAsset } from '../media/process'
import { makeSmoothCopy, smoothArgs, type SmoothResult } from '../media/smooth'
import { PITCH_RATE, pitchShiftArgs } from '../render/pitch'
import { prepareRenderDir } from '../render/export'
import { createAssetFromFile } from '../services/assets'
import { type Client, claimJob, setup, signup } from './helpers'

let client: Client
let app: Awaited<ReturnType<typeof setup>>['app']
let workspaceId: string
let userId: string
let tmp: string
let video: ReturnType<typeof assetDoc>

beforeAll(async () => {
  const t = await setup()
  app = t.app
  const u = await signup(t.app)
  client = u.client
  workspaceId = u.workspaceId
  userId = (await client.json('GET', '/api/auth/me')).body.user.id
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-speed-'))
  const clip = path.join(tmp, 'moving.mp4')
  // a small moving picture at 15 fps with a 440 Hz tone under it
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=15:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip])
  const created = await createAssetFromFile({ workspaceId, userId, filePath: clip, name: 'moving.mp4', mime: 'video/mp4', kind: 'video', origin: 'upload' })
  video = assetDoc(await processAsset(created.id, inlineContext({ id: 't', kind: 'asset.process', workspaceId, userId, projectId: null, input: {} })))
})

describe('smooth slow motion (E-17)', () => {
  it('makes a copy of the stretch asked for with frames made in between, ready for the editor', { timeout: 120_000 }, async () => {
    const r = await client.json('POST', `/api/assets/${video.id}/smooth`, { from: 0.5, to: 1.5, fps: 60 })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.kind).toBe('media.smooth')
    const res: SmoothResult = await makeSmoothCopy(inlineContext(await claimJob(r.body.id)))
    expect(res).toMatchObject({ from: 0.5, fps: 60 })
    // up to the last frame it could make frames before
    expect(res.to).toBeGreaterThan(1.4)
    expect(res.to).toBeLessThanOrEqual(1.5)
    expect(res.asset.kind).toBe('video')
    expect(res.asset.fps).toBeCloseTo(60, 0)
    expect(res.asset.duration).toBeCloseTo(res.to - res.from, 2)
    // processed like an upload: an editing copy and a thumbnail
    expect(res.asset.proxySrc).toBeTruthy()
    const rec = await client.json('GET', `/api/assets/${res.asset.id}`)
    expect(rec.body).toMatchObject({ status: 'ready', origin: 'smooth' })
  })

  it('takes only editors, video clips and a sensible range', async () => {
    expect((await client.json('POST', `/api/assets/${video.id}/smooth`, { from: 2, to: 1, fps: 60 })).status).toBe(400)
    expect((await client.json('POST', `/api/assets/${video.id}/smooth`, { from: 0, to: 500, fps: 60 })).status).toBe(400)
    expect((await client.json('POST', `/api/assets/${video.id}/smooth`, { from: 0, to: 1, fps: 500 })).status).toBe(400)
    const other = await signup(app, 'Outsider')
    expect([403, 404]).toContain((await other.client.json('POST', `/api/assets/${video.id}/smooth`, { from: 0, to: 1, fps: 60 })).status)
    const V = await signup(app, 'Viewer')
    const inv = await client.json('POST', `/api/workspaces/${workspaceId}/invites`, { email: V.email, role: 'viewer' })
    await V.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
    expect((await V.client.json('POST', `/api/assets/${video.id}/smooth`, { from: 0, to: 1, fps: 60 })).status).toBe(403)
  })

  it('scales a big file down, never up, and interpolates motion', () => {
    const args = smoothArgs('in.mp4', 'out.mp4', { from: 1.25, length: 2, fps: 240 })
    expect(args.slice(0, 4)).toEqual(['-ss', '1.25', '-t', '2'])
    const vf = args[args.indexOf('-vf') + 1]
    expect(vf).toContain('min(ih,1080)')
    expect(vf).toContain('minterpolate=fps=120:mi_mode=mci')
    expect(args).toContain('-an')
  })
})

/** Zero crossings per second of 16-bit PCM in a WAV file: twice its frequency for a pure tone. */
function toneHz(file: string): number {
  const buf = fs.readFileSync(file)
  const data = buf.indexOf('data') + 8
  const samples: number[] = []
  // left channel of interleaved stereo
  for (let i = data; i + 3 < buf.length; i += 4) samples.push(buf.readInt16LE(i))
  const from = Math.floor(samples.length * 0.1)
  const to = Math.floor(samples.length * 0.9)
  let crossings = 0
  for (let i = from + 1; i < to; i++) if (samples[i - 1] < 0 !== samples[i] < 0) crossings++
  return crossings / 2 / ((to - from) / PITCH_RATE)
}

describe('the pitch toggle in the export (E-17)', () => {
  it('a copy at 2x is half as long and an octave up', { timeout: 60_000 }, async () => {
    const src = path.join(tmp, 'tone.wav')
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3', '-c:a', 'pcm_s16le', src])
    const out = path.join(tmp, 'fast.wav')
    await ffmpeg(pitchShiftArgs(src, out, [{ from: 0.5, to: 2.5, len: 1 }]))
    expect((await probe(out)).duration).toBeCloseTo(1, 1)
    expect(toneHz(out)).toBeCloseTo(880, -1)
  })

  it('a ramp is made of slices that join into one copy of the clip’s length', { timeout: 60_000 }, async () => {
    const src = path.join(tmp, 'tone.wav')
    const out = path.join(tmp, 'ramp.wav')
    const slices = [{ from: 0, to: 0.25, len: 0.5 }, { from: 0.25, to: 1.25, len: 0.5 }, { from: 1.25, to: 2.25, len: 1 }]
    await ffmpeg(pitchShiftArgs(src, out, slices))
    expect((await probe(out)).duration).toBeCloseTo(2, 1)
  })

  it('the composition plays the copy for a shifted clip, a rate lane for a ramp, and the smooth copy for the picture', { timeout: 120_000 }, async () => {
    let p = createProject({ width: 320, height: 180 })
    p = addAsset(p, video)
    p = addItem(p, createVideoItem(video, 0, { in: 0.5, duration: 2 }))
    const id = mainTrack(p)!.items[0].id
    p = setPitchShift(setItemSpeed(p, id, 0.5), id, true)
    // a smooth copy already made for it
    const it = findItem(p, id)!.item as VideoItem
    const range = smoothRange(p, it)
    const job = await client.json('POST', `/api/assets/${video.id}/smooth`, { ...range, fps: 30 })
    const made = await makeSmoothCopy(inlineContext(await claimJob(job.body.id)))
    p = applySmoothCopy(setSmoothJob(p, id, { ...range, fps: 30, jobId: job.body.id }), job.body.id, made.asset, made.to)
    const dir = path.join(tmp, 'render-a')
    const prep = await prepareRenderDir(p, workspaceId, dir)
    const html = fs.readFileSync(prep.index, 'utf8')
    expect(prep.files).toContain(`pitch/${id}.wav`)
    expect(html).toMatch(new RegExp(`<audio id="a-${id}" src="pitch/${id}.wav"[^>]*data-media-start="0"`))
    expect(html).toMatch(new RegExp(`<video id="v-${id}" data-ps-content src="assets/${made.asset.id}\\.`))
    expect((await probe(path.join(dir, `pitch/${id}.wav`))).duration).toBeCloseTo(4, 1)
    // a ramp instead, pitch kept: a rate lane on both elements, the source's sound
    const q = setPitchShift(applyRampPreset(p, id, 'rampUp'), id, false)
    const html2 = fs.readFileSync((await prepareRenderDir(q, workspaceId, path.join(tmp, 'render-b'))).index, 'utf8')
    expect(html2).toMatch(new RegExp(`<audio id="a-${id}" src="assets/${video.id}[^"]*"[^>]*"target":"rate"`))
    expect(html2).toMatch(new RegExp(`<video id="v-${id}"[^>]*"target":"rate"`))
    expect(html2).not.toContain('pitch/')
  })
})
