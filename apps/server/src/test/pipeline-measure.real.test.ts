// Before-and-after numbers for P-18 on local files (REAL_RENDER=1 only: real encodes and a real HyperFrames export).
// Prints one JSON line per measurement; the assertions only guard that the "after" isn't worse.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addAsset, addItem, createVideoItem, type Project } from '@producer/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { assetDoc } from '../dto'
import { enqueue } from '../jobs/queue'
import { inlineContext } from '../jobs/worker'
import { encodeH264, h264Args, hardwareEncoder, resetHardwareEncoder } from '../media/hwenc'
import { ffmpeg } from '../media/proc'
import { probe, processAsset } from '../media/process'
import { exportRender } from '../render/export'
import { prepareVideoSource, SOURCE_PREP } from '../render/sources'
import { createAssetFromFile } from '../services/assets'
import { S3Storage } from '../storage/s3'
import { startFakeS3 } from './fake-s3'
import { claimJob, type Client, setup, signup } from './helpers'

const REAL = process.env.REAL_RENDER === '1'
let client: Client
let workspaceId = ''
let userId = ''
let dir = ''
let long = ''
const report = (o: Record<string, unknown>) => console.log(`MEASURE ${JSON.stringify(o)}`)
const secs = (t0: number) => Math.round((performance.now() - t0) / 100) / 10
function du(p: string): number {
  if (!fs.existsSync(p)) return 0
  const st = fs.statSync(p)
  return st.isDirectory() ? fs.readdirSync(p).reduce((s, f) => s + du(path.join(p, f)), 0) : st.size
}

beforeAll(async () => {
  if (!REAL) return
  const t = await setup()
  const u = await signup(t.app, 'Measurer')
  client = u.client
  workspaceId = u.workspaceId
  userId = (await u.client.json('GET', '/api/auth/me')).body.user.id
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-measure-'))
  // five minutes of 1080p with sound, as a long screen or camera recording
  long = path.join(dir, 'long-1080p.mp4')
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '300', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', long])
}, 900_000)

describe.skipIf(!REAL)('P-18 measurements', () => {
  it('proxy encode: libx264 against the machine’s video hardware', async () => {
    const info = await probe(long)
    const time = async (found: Parameters<typeof resetHardwareEncoder>[0]) => {
      resetHardwareEncoder(found)
      const out = path.join(dir, `proxy-${found ?? 'x264'}.mp4`)
      const t0 = performance.now()
      const used = await encodeH264((enc) => ['-i', long, '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=1280:720,format=yuv420p', ...h264Args(enc, { crf: 26, gop: 15 }), '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', out], (args) => ffmpeg(args))
      return { encoder: used ?? 'libx264', seconds: secs(t0), mb: Math.round(fs.statSync(out).size / 1e5) / 10 }
    }
    const sw = await time(null)
    resetHardwareEncoder()
    const hw = await hardwareEncoder()
    const fast = hw ? await time(hw) : undefined
    report({ what: 'proxy of 5 min 1080p30', source: `${info.width}x${info.height}`, software: sw, hardware: fast ?? 'none on this machine' })
    resetHardwareEncoder(null)
    expect(sw.seconds).toBeGreaterThan(0)
  }, 1_800_000)

  it('export: two 4 s clips of a 5-minute source, the whole file against the parts used', async () => {
    const created = await createAssetFromFile({ workspaceId, userId, filePath: long, name: 'long.mp4', mime: 'video/mp4', kind: 'video', origin: 'upload' })
    const row = await processAsset(created.id, inlineContext({ id: 'm', kind: 'asset.process', workspaceId, userId, projectId: null, input: {} }))
    const r = await client.json('POST', '/api/projects', { workspaceId, name: 'Measure', width: 1920, height: 1080 })
    let p = r.body.project as Project
    const a = assetDoc(row)
    p = addAsset(p, a)
    p = addItem(p, createVideoItem(a, 0, { in: 60, duration: 4 }))
    p = addItem(p, createVideoItem(a, 4, { in: 240, duration: 4 }))
    await client.json('PUT', `/api/projects/${r.body.project.id}`, { project: p, baseVersion: r.body.version })
    process.env.KEEP_RENDERS = '1'
    const run = async (trim: boolean) => {
      SOURCE_PREP.trim = trim
      const job = await enqueue('export.render', { projectId: r.body.project.id, resolution: '1080p', fps: 30, quality: 'standard', format: 'mp4' }, { workspaceId, userId, projectId: r.body.project.id })
      const t0 = performance.now()
      let prepared = 0
      const jc = { ...inlineContext(await claimJob(job.id)), progress: (f: number) => void (f >= 0.09 && !prepared && (prepared = secs(t0))) }
      await exportRender(jc)
      const rd = path.join(ctx().config.dataDir, 'renders', job.id)
      const out = { trim, seconds: secs(t0), preparedSeconds: prepared, renderDirMb: Math.round(du(path.join(rd, 'assets')) / 1e5) / 10 }
      fs.rmSync(rd, { recursive: true, force: true })
      return out
    }
    const before = await run(false)
    const after = await run(true)
    SOURCE_PREP.trim = true
    delete process.env.KEEP_RENDERS
    report({ what: 'export 8 s from a 5 min 1080p source (local storage)', sourceMb: Math.round(fs.statSync(long).size / 1e5) / 10, before, after })
    expect(after.renderDirMb).toBeLessThan(before.renderDirMb)
  }, 3_600_000)

  it('S3: bytes read from the bucket to cut the parts used, against downloading the file', async () => {
    const s3 = await startFakeS3()
    try {
      const bucket = new S3Storage({ bucket: s3.bucket, endpoint: s3.url, region: 'auto', accessKeyId: 'k', secretAccessKey: 's', forcePathStyle: true })
      await bucket.putFile('ws/w/assets/a/source.mp4', long, 'video/mp4')
      const url = await bucket.presignGet('ws/w/assets/a/source.mp4', { expiresSec: 3600 })
      const info = await probe(long)
      fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
      const start = s3.bytesOut
      const t0 = performance.now()
      await prepareVideoSource(url, 'a', [{ from: 58.5, to: 65.5 }, { from: 238.5, to: 245.5 }], dir, { info, matrix: 'smpte170m', ext: '.mp4', quality: 'standard' })
      const read = s3.bytesOut - start
      report({ what: 'S3 source, two 7 s windows of 5 min', fileMb: Math.round(fs.statSync(long).size / 1e5) / 10, readFromBucketMb: Math.round(read / 1e5) / 10, seconds: secs(t0) })
      expect(read).toBeLessThan(fs.statSync(long).size / 4)
    } finally {
      await s3.close()
    }
  }, 900_000)
})
