// Loudness normalisation on export (E-14): the exported sound lands on the platform's target, the picture is kept.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { addAsset, addItem, createVideoItem, type Project } from '@producer/core'
import { ctx } from '../context'
import { assets, exportsTable } from '../db/schema'
import { assetDoc } from '../dto'
import { getJob } from '../jobs/queue'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { probe, processAsset } from '../media/process'
import { exportRender } from '../render/export'
import { measureLoudness, normalizeLoudness, parseLoudnorm } from '../render/loudness'
import { createAssetFromFile, localSource } from '../services/assets'
import { type Client, claimJob, setup, signup } from './helpers'

let tmp: string
/** A 3 s test picture with a quiet tone (about -35 LUFS). */
let quiet: string
/** The same picture with no sound at all. */
let silent: string
let client: Client
let workspaceId: string
let userId: string

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app)
  client = u.client
  workspaceId = u.workspaceId
  userId = (await u.client.json('GET', '/api/auth/me')).body.user.id
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-loud-'))
  quiet = path.join(tmp, 'quiet.mp4')
  silent = path.join(tmp, 'silent.mp4')
  const pic = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30']
  await ffmpeg([...pic, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-af', 'volume=0.02', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', quiet])
  await ffmpeg([...pic, '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent])
})

describe('loudness normalisation (E-14)', () => {
  it('reads what loudnorm measured', () => {
    const out = 'noise\n[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-35.20",\n\t"input_tp" : "-31.10",\n\t"input_lra" : "0.00",\n\t"input_thresh" : "-45.20",\n\t"output_i" : "-16.0",\n\t"target_offset" : "0.10"\n}\n'
    expect(parseLoudnorm(out)).toEqual({ i: -35.2, tp: -31.1, lra: 0, thresh: -45.2, offset: 0.1 })
    expect(parseLoudnorm('{"input_i":"-inf","input_tp":"-inf","input_lra":"0","input_thresh":"-70","target_offset":"0"}')).toBeUndefined()
  })

  it('brings a quiet mix up to the YouTube target and keeps the picture', async () => {
    const before = await measureLoudness(quiet)
    expect(before!.i).toBeLessThan(-25)
    const out = await normalizeLoudness(quiet, path.join(tmp, 'yt.mp4'), -14, { format: 'mp4' })
    expect(out).toBe(path.join(tmp, 'yt.mp4'))
    expect((await measureLoudness(out))!.i).toBeGreaterThan(-15)
    expect((await measureLoudness(out))!.i).toBeLessThan(-13)
    const info = await probe(out)
    expect({ w: info.width, h: info.height, audio: info.hasAudio }).toEqual({ w: 320, h: 180, audio: true })
    expect(info.duration).toBeCloseTo(3, 0)
  })

  it('leaves a video with no sound as it is', async () => {
    expect(await normalizeLoudness(silent, path.join(tmp, 'silent-out.mp4'), -14, { format: 'mp4' })).toBe(silent)
    expect(fs.existsSync(path.join(tmp, 'silent-out.mp4'))).toBe(false)
  })

  it('an export asked for at the podcast target is stored at it', async () => {
    const created = await createAssetFromFile({ workspaceId, userId, filePath: quiet, name: 'quiet.mp4', mime: 'video/mp4', kind: 'video', origin: 'upload' })
    const row = await processAsset(created.id, inlineContext({ id: 't', kind: 'asset.process', workspaceId, userId, projectId: null, input: {} }))
    const a = assetDoc(row)
    const r = await client.json('POST', '/api/projects', { workspaceId, name: 'Loud', width: 1280, height: 720 })
    let p = r.body.project as Project
    p = addAsset(p, a)
    p = addItem(p, createVideoItem(a, 0, { duration: 3 }))
    expect((await client.json('PUT', `/api/projects/${p.id}`, { project: p, baseVersion: r.body.version })).status).toBe(200)
    // the route takes the setting
    const asked = await client.json('POST', `/api/projects/${p.id}/export`, { resolution: '720p', loudness: 'podcast' })
    expect(asked.status).toBe(200)
    expect((await getJob(asked.body.id))!.input).toMatchObject({ loudness: 'podcast' })
    expect((await client.json('POST', `/api/projects/${p.id}/export`, { loudness: 'loud' })).status).toBe(400)
    const job = await claimJob(asked.body.id, 'loud-worker')
    // the quiet clip stands in for Chrome's render
    await exportRender(inlineContext(job), { lint: async () => ({ errors: [], warnings: 0 }), render: async (_dir, out) => fs.copyFileSync(quiet, out) })
    const [ex] = await ctx().db.select().from(exportsTable).where(eq(exportsTable.jobId, job.id))
    const [video] = await ctx().db.select().from(assets).where(eq(assets.id, ex.assetId))
    const file = await localSource(video, tmp)
    const m = await measureLoudness(file)
    expect(m!.i).toBeGreaterThan(-17)
    expect(m!.i).toBeLessThan(-15)
  })
})
