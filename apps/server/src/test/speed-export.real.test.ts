// A reversed clip with a speed ramp, rendered for real (HyperFrames and Chrome, a few minutes). Runs only with
// REAL_RENDER=1. The source's brightness is its own clock (grey level = 15 × seconds), so every exported frame says
// which moment of the recording it shows; a plain export of the same source calibrates level → seconds.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addAsset, addItem, applyRampPreset, clipSourceAt, createVideoItem, mainTrack, type Project, type VideoItem } from '@producer/core'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { assets, exportsTable } from '../db/schema'
import { assetDoc } from '../dto'
import { enqueue } from '../jobs/queue'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { processAsset } from '../media/process'
import { exportRender } from '../render/export'
import { createAssetFromFile } from '../services/assets'
import { claimJob, type Client, setup, signup } from './helpers'

const REAL = process.env.REAL_RENDER === '1'
let client: Client
let workspaceId = ''
let userId = ''
let dir = ''

/** Mean grey level of the middle of `file`'s frame at time `t`. */
async function level(file: string, t: number): Promise<number> {
  const out = path.join(dir, `px-${Math.random().toString(36).slice(2)}.raw`)
  await ffmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=16:16:(iw-16)/2:(ih-16)/2,format=gray', '-f', 'rawvideo', out])
  const px = fs.readFileSync(out)
  return px.reduce((a, b) => a + b, 0) / px.length
}

beforeAll(async () => {
  if (!REAL) return
  const t = await setup()
  const u = await signup(t.app, 'Speedster')
  client = u.client
  workspaceId = u.workspaceId
  userId = (await u.client.json('GET', '/api/auth/me')).body.user.id
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-speed-'))
}, 300_000)

async function exportOf(file: string, name: string, edit: (p: Project, id: string) => Project) {
  const created = await createAssetFromFile({ workspaceId, userId, filePath: file, name, mime: 'video/mp4', kind: 'video', origin: 'upload' })
  const row = await processAsset(created.id, inlineContext({ id: 'c', kind: 'asset.process', workspaceId, userId, projectId: null, input: {} }))
  const r = await client.json('POST', '/api/projects', { workspaceId, name, width: 320, height: 180 })
  let p = r.body.project as Project
  const a = assetDoc(row)
  p = addAsset(p, a)
  p = addItem(p, createVideoItem(a, 0, { in: 3, duration: 8 }))
  const id = mainTrack(p)!.items[0].id
  p = edit(p, id)
  await client.json('PUT', `/api/projects/${r.body.project.id}`, { project: p, baseVersion: r.body.version })
  const job = await enqueue('export.render', { projectId: r.body.project.id, resolution: '720p', fps: 30, quality: 'standard', format: 'mp4' }, { workspaceId, userId, projectId: r.body.project.id })
  const result = await exportRender(inlineContext(await claimJob(job.id)))
  const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, (result as { exportId: string }).exportId)))[0]
  const out = (await ctx().db.select().from(assets).where(eq(assets.id, ex.assetId)))[0]
  return { file: ctx().storage.localPath!(out.sourceKey), item: mainTrack(p)!.items[0] as VideoItem }
}

describe.skipIf(!REAL)('a reversed clip with a speed ramp, exported', () => {
  it('shows the moments of the recording the preview shows', async () => {
    const file = path.join(dir, 'clock.mp4')
    // 16 s whose grey level counts the seconds (0..240)
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=16', '-vf', "geq=lum='min(240,15*T)':cb=128:cr=128,format=yuv420p", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', file])
    // calibration: the clip as it is (source 3..11 at 1x), level at each moment → seconds
    const plain = await exportOf(file, 'plain.mp4', (p) => p)
    const cal: Array<[number, number]> = []
    for (const t of [0.5, 2, 3.5, 5, 6.5, 7.5]) cal.push([await level(plain.file, t), 3 + t])
    const n = cal.length
    const mx = cal.reduce((a, c) => a + c[0], 0) / n
    const my = cal.reduce((a, c) => a + c[1], 0) / n
    const slope = cal.reduce((a, c) => a + (c[0] - mx) * (c[1] - my), 0) / cal.reduce((a, c) => a + (c[0] - mx) ** 2, 0)
    const seconds = (lv: number) => my + slope * (lv - mx)
    // reversed at one speed first: source 11 down to 3
    const one = await exportOf(file, 'reversed.mp4', (p, id) => ({ ...p, tracks: p.tracks.map((tr) => ({ ...tr, items: tr.items.map((i) => (i.id === id ? { ...i, reverse: true } : i)) })) }))
    const oneRows: Array<{ t: number; want: number; got: number }> = []
    for (const t of [0.5, 2, 4, 6, 7.5]) oneRows.push({ t, want: clipSourceAt(one.item, t), got: seconds(await level(one.file, t)) })
    console.log(JSON.stringify({ test: 'reversed', oneRows }))
    for (const r of oneRows) expect(Math.abs(r.got - r.want), `one speed at ${r.t} s`).toBeLessThan(0.25)
    // reversed and ramped up: starts slow at source 11, ends fast at source 3
    const rev = await exportOf(file, 'reversed-ramp.mp4', (p, id) => applyRampPreset({ ...p, tracks: p.tracks.map((tr) => ({ ...tr, items: tr.items.map((i) => (i.id === id ? { ...i, reverse: true } : i)) })) }, id, 'rampUp'))
    const it = rev.item
    const rows: Array<{ t: number; want: number; got: number; constant: number }> = []
    for (const k of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const t = it.duration * k
      // what a reversed clip at one (the average) speed would show instead
      rows.push({ t, want: clipSourceAt(it, t), got: seconds(await level(rev.file, t)), constant: it.in + (it.duration - t) * it.speed })
    }
    console.log(JSON.stringify({ test: 'reversed ramp', slope, rows }))
    for (const r of rows) expect(Math.abs(r.got - r.want), `at ${r.t.toFixed(2)} s`).toBeLessThan(0.25)
    // and it isn't the one-speed mapping (they differ by over a second in the middle)
    const mid = rows[2]
    expect(Math.abs(mid.constant - mid.want)).toBeGreaterThan(0.8)
    expect(Math.abs(mid.got - mid.constant)).toBeGreaterThan(0.5)
  }, 1_500_000)
})
