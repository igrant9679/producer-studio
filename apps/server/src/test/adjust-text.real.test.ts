// Text and the new path shapes under an adjustment layer, for real (phase 5 "not graded yet" and tracker #8): a white
// title, a yellow star and a red rectangle under an adjustment layer whose curve inverts, exported by HyperFrames. The
// title comes out dark, the star blue, the rectangle cyan. Runs only with REAL_RENDER=1 (ADJUST_FRAME=<png> keeps a frame).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addAdjustmentLayer, addItem, createProject, createShapeItem, createTextItem, updateItem, type AdjustmentItem, type Project } from '@producer/core'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { assets, exportsTable } from '../db/schema'
import { enqueue } from '../jobs/queue'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { exportRender } from '../render/export'
import { claimJob, type Client, setup, signup } from './helpers'

const REAL = process.env.REAL_RENDER === '1'
let client: Client
let workspaceId = ''
let userId = ''

beforeAll(async () => {
  if (!REAL) return
  const t = await setup()
  const A = await signup(t.app, 'Grader')
  client = A.client
  workspaceId = A.workspaceId
  userId = (await A.client.json('GET', '/api/auth/me')).body.user.id
}, 300_000)

describe.skipIf(!REAL)('an adjustment layer over text and shapes, exported', () => {
  it('inverts them as it inverts pictures', async () => {
    const r = await client.json('POST', '/api/projects', { workspaceId, name: 'Graded', width: 1280, height: 720 })
    let p: Project = { ...createProject({ id: r.body.project.id, name: 'Graded', width: 1280, height: 720, fps: 30 }), background: '#808080', createdAt: Date.now() }
    const title = createTextItem(0, 'heading', { text: 'GRADED', duration: 2, transform: { x: 0, y: -200, scale: 1, rotation: 0 } })
    title.style = { ...title.style, color: '#ffffff', fontSize: 140 }
    p = addItem(p, title)
    p = addItem(p, createShapeItem(0, { shape: 'star', fill: '#ffff00', width: 300, height: 300, duration: 2, transform: { x: -250, y: 120, scale: 1, rotation: 0 } } as never))
    p = addItem(p, createShapeItem(0, { shape: 'rect', fill: '#ff0000', width: 260, height: 200, duration: 2, transform: { x: 300, y: 120, scale: 1, rotation: 0 } } as never))
    const adj = addAdjustmentLayer(p, 0, 2)
    p = updateItem<AdjustmentItem>(adj.project, adj.id, { grade: { curves: { master: [[0, 1], [1, 0]] } } } as never)
    const saved = await client.json('PUT', `/api/projects/${r.body.project.id}`, { project: p, baseVersion: r.body.version })
    expect(saved.status).toBe(200)
    const j = await enqueue('export.render', { projectId: r.body.project.id, resolution: '720p', fps: 30, quality: 'standard', format: 'mp4' }, { workspaceId, userId, projectId: r.body.project.id })
    const result = await exportRender(inlineContext(await claimJob(j.id)))
    const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, (result as { exportId: string }).exportId)))[0]
    const out = (await ctx().db.select().from(assets).where(eq(assets.id, ex.assetId)))[0]
    const file = ctx().storage.localPath!(out.sourceKey)
    const frame = process.env.ADJUST_FRAME || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-adj-')), 'frame.png')
    await ffmpeg(['-ss', '1', '-i', file, '-frames:v', '1', frame])
    const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => {
      const i = (Math.round(y) * info.width + Math.round(x)) * info.channels
      return [data[i], data[i + 1], data[i + 2]]
    }
    const cx = info.width / 2
    const cy = info.height / 2
    // star centre (yellow → blue), rectangle centre (red → cyan)
    const star = at(cx - 250, cy + 120)
    const rect = at(cx + 300, cy + 120)
    console.log(JSON.stringify({ star, rect, frame }))
    expect(star[2]).toBeGreaterThan(200)
    expect(star[0] + star[1]).toBeLessThan(120)
    expect(rect[0]).toBeLessThan(60)
    expect(rect[1] + rect[2]).toBeGreaterThan(400)
  }, 900_000)
})
