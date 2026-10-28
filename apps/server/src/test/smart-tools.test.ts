// Smart tools (E-21): stabilise, denoise and background removal make a processed copy of the part of a clip it shows,
// saved as a new clip (processed inside the job) with where it starts in the original. The jobs run here on small
// generated clips with this machine's ffmpeg; what ffmpeg lacks is faked by narrowing its filter list.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { SmartJobResult, SmartToolsInfo } from '@producer/core'
import { ctx } from '../context'
import { assetDoc } from '../dto'
import { inlineContext } from '../jobs/worker'
import { removeBackground, bgRemovalCommand, frameFiles, splitCommand } from '../media/bgremove'
import { audioDenoiseFilter, denoiseClip, videoDenoiseFilter } from '../media/denoise'
import { ffmpeg } from '../media/proc'
import { probe, processAsset } from '../media/process'
import { resetFfmpegFilters, shiftTranscript, sourceRange } from '../media/smartTools'
import { stabiliseClip, vidstabSmoothing } from '../media/stabilise'
import { loadAsset, createAssetFromFile } from '../services/assets'
import { Client, claimJob, setup, signup } from './helpers'

let client: Client
let workspaceId: string
let userId: string
let tmp: string
let shaky: ReturnType<typeof assetDoc>
let green: ReturnType<typeof assetDoc>
let tone: ReturnType<typeof assetDoc>

const FAKE_TOOL = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'fixtures', 'fake-bg-removal.mjs')
const jc = (job: Awaited<ReturnType<typeof claimJob>>) => inlineContext(job)

async function addClip(file: string, name: string, mime: string, kind: 'video' | 'audio', ws = workspaceId, user = userId) {
  const created = await createAssetFromFile({ workspaceId: ws, userId: user, filePath: file, name, mime, kind, origin: 'upload' })
  return assetDoc(await processAsset(created.id, inlineContext({ id: 't', kind: 'asset.process', workspaceId: ws, userId: user, projectId: null, input: {} })))
}

/** Ask for a tool through the API, then run its job here. */
async function runTool(assetId: string, tool: string, body: Record<string, unknown>, handler: typeof stabiliseClip): Promise<SmartJobResult> {
  const r = await client.json('POST', `/api/assets/${assetId}/${tool}`, body)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return handler(jc(await claimJob(r.body.id)))
}

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app)
  client = u.client
  workspaceId = u.workspaceId
  userId = (await client.json('GET', '/api/auth/me')).body.user.id
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-smart-'))
  // a test pattern that jitters a few pixels every frame, over a tone with hiss
  const shakyFile = path.join(tmp, 'shaky.mp4')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=s=360x240:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:d=4',
    '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.08:sample_rate=48000:d=4',
    '-filter_complex', "[0:v]crop=320:200:'20+12*sin(n*1.7)':'20+10*cos(n*2.3)'[v];[1:a][2:a]amix=inputs=2:normalize=0[a]",
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', shakyFile,
  ])
  shaky = await addClip(shakyFile, 'shaky.mp4', 'video/mp4', 'video')
  // a red square moving over pure green
  const greenFile = path.join(tmp, 'green.mp4')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=160x120:r=10:d=2',
    '-f', 'lavfi', '-i', 'color=c=red:s=40x40:r=10:d=2',
    '-filter_complex', "[0:v][1:v]overlay=x='20+t*30':y=40[v]", '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-crf', '10', greenFile,
  ])
  green = await addClip(greenFile, 'green.mp4', 'video/mp4', 'video')
  const toneFile = path.join(tmp, 'tone.wav')
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3', toneFile])
  tone = await addClip(toneFile, 'tone.wav', 'audio/wav', 'audio')
})

afterEach(() => {
  resetFfmpegFilters()
  ctx().config.bgRemovalCmd = undefined
})

describe('what the server can do', () => {
  it("says what this ffmpeg has, and why a tool is off", async () => {
    const all = (await client.json('GET', '/api/smart-tools')).body as SmartToolsInfo
    // this machine's ffmpeg is a full build
    expect(all.stabilise).toEqual({ method: 'vidstab' })
    expect(all.denoise.audio).toEqual(['afftdn'])
    expect(all.denoise.video).toEqual(['hqdn3d', 'nlmeans'])
    expect(all.removeBackground.available).toBe(false)
    expect(all.why.removeBackground).toMatch(/BG_REMOVAL_CMD/)
    resetFfmpegFilters(['deshake', 'afftdn'])
    const less = (await client.json('GET', '/api/smart-tools')).body as SmartToolsInfo
    expect(less.stabilise).toEqual({ method: 'deshake' })
    expect(less.why.denoise).toMatch(/can't denoise pictures/)
    resetFfmpegFilters([])
    const none = (await client.json('GET', '/api/smart-tools')).body as SmartToolsInfo
    expect(none.stabilise).toBeNull()
    expect(none.why.stabilise).toMatch(/no stabiliser/)
    // and the jobs aren't queued when the tool is missing
    expect((await client.json('POST', `/api/assets/${shaky.id}/stabilise`, {})).status).toBe(501)
    expect((await client.json('POST', `/api/assets/${shaky.id}/denoise`, { target: 'audio' })).status).toBe(501)
    expect((await client.json('POST', `/api/assets/${green.id}/remove-background`, {})).status).toBe(501)
    // signed out: nothing
    expect((await new Client((await setup()).app).json('GET', '/api/smart-tools')).status).toBe(401)
  })

  it('refuses the wrong kind of clip, a bad range, a viewer and other spaces', async () => {
    expect((await client.json('POST', `/api/assets/${tone.id}/stabilise`, {})).status).toBe(400)
    expect((await client.json('POST', `/api/assets/${tone.id}/denoise`, { target: 'video' })).status).toBe(400)
    expect((await client.json('POST', `/api/assets/${shaky.id}/stabilise`, { from: 2, to: 1 })).status).toBe(400)
    expect((await client.json('POST', `/api/assets/${shaky.id}/denoise`, { target: 'audio', method: 'nlmeans' })).status).toBe(400)
    expect((await client.json('POST', `/api/assets/${shaky.id}/denoise`, {})).status).toBe(400)
    const other = await signup((await setup()).app, 'Outsider')
    expect([403, 404]).toContain((await other.client.json('POST', `/api/assets/${shaky.id}/stabilise`, {})).status)
    // a viewer of the space looks but doesn't make copies
    const ws = (await client.json('POST', '/api/workspaces', { name: 'Team' })).body as { id: string }
    const viewer = await signup((await setup()).app, 'Viewer')
    const inv = await client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: viewer.email, role: 'viewer' })
    await viewer.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
    const teamClip = await addClip(path.join(tmp, 'green.mp4'), 'team.mp4', 'video/mp4', 'video', ws.id)
    expect((await viewer.client.json('POST', `/api/assets/${teamClip.id}/stabilise`, {})).status).toBe(403)
    expect((await client.json('POST', `/api/assets/${teamClip.id}/stabilise`, {})).status).toBe(200)
  })
})

describe('stabilise', () => {
  it('makes a steadied copy of the part the clip shows, starting where that part starts', async () => {
    const res = await runTool(shaky.id, 'stabilise', { from: 1, to: 3.5, smoothing: 40 }, stabiliseClip)
    expect(res).toMatchObject({ tool: 'stabilise', offset: 1, sourceAssetId: shaky.id })
    expect(res.asset.status).toBe('ready')
    expect(res.asset.asset.name).toBe('shaky (stabilised).mp4')
    expect(Math.abs(res.asset.asset.duration! - 2.5)).toBeLessThan(0.1)
    expect(res.asset.asset.hasAudio).toBe(true)
    expect(res.asset.asset.proxySrc).toBeDefined()
    const row = await loadAsset(res.asset.asset.id)
    expect(row.meta.derivedFrom).toEqual({ assetId: shaky.id, tool: 'stabilise', offset: 1, settings: { method: 'vidstab', smoothing: 40 } })
    expect(row.origin).toBe('smart')
    // it is in the media library like any clip
    const list = (await client.json('GET', `/api/assets?workspaceId=${workspaceId}`)).body
    expect(JSON.stringify(list)).toContain(res.asset.asset.id)
  })

  it('uses deshake where this ffmpeg has no vid.stab', async () => {
    resetFfmpegFilters(['deshake'])
    const res = await runTool(shaky.id, 'stabilise', { from: 0, to: 2 }, stabiliseClip)
    expect((await loadAsset(res.asset.asset.id)).meta.derivedFrom?.settings).toEqual({ method: 'deshake', smoothing: 50 })
    expect(Math.abs(res.asset.asset.duration! - 2)).toBeLessThan(0.1)
  })

  it('maps smoothing to vid.stab frames', () => {
    expect([vidstabSmoothing(0), vidstabSmoothing(50), vidstabSmoothing(100), vidstabSmoothing(500)]).toEqual([5, 33, 60, 60])
  })
})

describe('denoise', () => {
  it("cleans a video's sound over the whole file, its picture copied as it is", async () => {
    const res = await runTool(shaky.id, 'denoise', { target: 'audio', strength: 70 }, denoiseClip)
    expect(res.offset).toBe(0)
    expect(res.asset.asset.kind).toBe('video')
    expect(res.asset.asset.duration).toBeCloseTo(shaky.duration!, 1)
    const row = await loadAsset(res.asset.asset.id)
    expect(row.meta.derivedFrom).toMatchObject({ tool: 'denoise', settings: { target: 'audio', method: 'afftdn', strength: 70 } })
    // quieter hiss: the cleaned copy's level is lower than the original's
    const level = async (file: string) => Number(/mean_volume: (-?[\d.]+) dB/.exec((await ffmpeg(['-i', file, '-af', 'highpass=f=3000,volumedetect', '-f', 'null', '-'])).stderr)![1])
    const local = (key: string) => ctx().storage.localPath!(key)
    expect(await level(local(row.sourceKey))).toBeLessThan((await level(local((await loadAsset(shaky.id)).sourceKey))) - 3)
  })

  it("makes a sound file of a video's sound for its separated sound clip, and cleans a sound clip", async () => {
    const sep = await runTool(shaky.id, 'denoise', { target: 'audio', soundOnly: true }, denoiseClip)
    expect(sep.asset.asset.kind).toBe('audio')
    expect(sep.asset.asset.name).toBe('shaky (denoised).m4a')
    const snd = await runTool(tone.id, 'denoise', { target: 'audio' }, denoiseClip)
    expect(snd.asset.asset.kind).toBe('audio')
    expect(snd.asset.asset.duration).toBeCloseTo(3, 1)
  })

  it('cleans the picture of the part the clip shows', async () => {
    const res = await runTool(shaky.id, 'denoise', { target: 'video', method: 'hqdn3d', from: 0.5, to: 2 }, denoiseClip)
    expect(res.offset).toBe(0.5)
    // (the sound's encoder delay can make the file a frame or two longer)
    expect(Math.abs(res.asset.asset.duration! - 1.5)).toBeLessThan(0.1)
    expect((await loadAsset(res.asset.asset.id)).meta.derivedFrom?.settings).toMatchObject({ target: 'video', method: 'hqdn3d' })
  })

  it('builds the filters from a strength', () => {
    expect(audioDenoiseFilter('afftdn', 0)).toBe('afftdn=nr=6:nf=-30:tn=1')
    expect(audioDenoiseFilter('afftdn', 100)).toBe('afftdn=nr=40:nf=-30:tn=1')
    expect(audioDenoiseFilter('arnndn', 50, 'm.rnnn')).toBe('arnndn=m=m.rnnn:mix=0.65')
    expect(videoDenoiseFilter('hqdn3d', 50)).toBe('hqdn3d=4.00:3.00:6.00:4.50')
    expect(videoDenoiseFilter('nlmeans', 100)).toBe('nlmeans=s=9.00:p=7:r=15')
  })
})

describe('background removal', () => {
  const useTool = (mode: string) => {
    ctx().config.bgRemovalCmd = `"${process.execPath}" "${FAKE_TOOL}" "${ctx().config.ffmpegPath}" {in} {out} ${mode}`
  }

  it('is off until the owner sets a command, and says so', async () => {
    const r = await client.json('POST', `/api/assets/${green.id}/remove-background`, {})
    expect(r.status).toBe(501)
    expect(r.body.error).toMatch(/not set up/)
  })

  it("runs the configured tool on the clip's part and saves its PNG frames as a WebM with alpha", async () => {
    useTool('frames')
    const res = await runTool(green.id, 'remove-background', { from: 0.5, to: 2 }, removeBackground)
    expect(res).toMatchObject({ tool: 'removeBackground', offset: 0.5 })
    const row = await loadAsset(res.asset.asset.id)
    expect(row.mime).toBe('video/webm')
    expect(row.meta.alpha).toBe(true)
    const info = await probe(ctx().storage.localPath!(row.sourceKey))
    expect(info.alpha).toBe(true)
    expect(info.duration).toBeCloseTo(1.5, 1)
    // the editor's proxy keeps the transparency, and is served as WebM
    expect(row.proxyKey).toMatch(/proxy\.webm$/)
    expect((await probe(ctx().storage.localPath!(row.proxyKey!))).alpha).toBe(true)
    const proxy = await client.req('GET', `/api/media/${row.id}/proxy`)
    expect(proxy.headers.get('content-type')).toBe('video/webm')
    // the green is gone, the red square stays: a frame decoded with its alpha
    const png = path.join(tmp, 'frame.rgba')
    await ffmpeg(['-c:v', 'libvpx-vp9', '-ss', '0.5', '-i', ctx().storage.localPath!(row.sourceKey), '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', png])
    const px = fs.readFileSync(png)
    const at = (x: number, y: number) => px[(y * 160 + x) * 4 + 3]
    expect(at(5, 5)).toBeLessThan(30)
    expect(at(150, 110)).toBeLessThan(30)
    const red = Math.round(20 + 1 * 30 + 20)
    expect(at(red, 60)).toBeGreaterThan(220)
  })

  it('takes an out.webm the tool made', async () => {
    useTool('webm')
    const res = await runTool(green.id, 'remove-background', {}, removeBackground)
    expect(res.offset).toBe(0)
    expect((await loadAsset(res.asset.asset.id)).meta.alpha).toBe(true)
  })

  it("fails with the tool's own last words", async () => {
    useTool('fail')
    const r = await client.json('POST', `/api/assets/${green.id}/remove-background`, {})
    await expect(removeBackground(jc(await claimJob(r.body.id)))).rejects.toThrow(/exit 3.*no model loaded/)
  })

  it('splits the command without a shell and fills in {in} and {out}', () => {
    expect(splitCommand(`"C:\\Program Files\\rembg\\rembg.exe" p -m 'u2 net' {in}  {out}`)).toEqual(['C:\\Program Files\\rembg\\rembg.exe', 'p', '-m', 'u2 net', '{in}', '{out}'])
    expect(bgRemovalCommand('tool --in={in} --out {out} ""', 'a b.mp4', 'o')).toEqual(['tool', '--in=a b.mp4', '--out', 'o', ''])
    const d = fs.mkdtempSync(path.join(tmp, 'frames-'))
    for (const f of ['f10.png', 'f9.png', 'f1.png', 'notes.txt']) fs.writeFileSync(path.join(d, f), '')
    expect(frameFiles(d)).toEqual(['f1.png', 'f9.png', 'f10.png'])
  })
})

describe('the copy lines up with the original', () => {
  it('keeps the transcript, moved to where the copy starts', () => {
    const t = { language: 'en', engine: 'x', segments: [{ start: 0.5, end: 2.5, text: 'one two', words: [{ w: 'one', start: 0.5, end: 1 }, { w: 'two', start: 2, end: 2.5 }] }, { start: 5, end: 6, text: 'later', words: [] }] }
    expect(shiftTranscript(t, 1, 3)!.segments).toEqual([{ start: 0, end: 1.5, text: 'one two', words: [{ w: 'two', start: 1, end: 1.5 }] }])
  })

  it('clamps the part to the file', () => {
    expect(sourceRange({ from: 2, to: 99 }, 4)).toEqual({ from: 2, length: 2 })
    expect(sourceRange({}, undefined)).toEqual({ from: 0 })
    expect(() => sourceRange({ from: 4, to: 9 }, 4)).toThrow(/too short/)
  })
})
