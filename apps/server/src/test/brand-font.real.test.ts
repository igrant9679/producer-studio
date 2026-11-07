// A space's uploaded brand font in a real export (phase 5: "FontFace + brand-font embedding in a real export"). Three
// lines of the same words in one frame: in a family the space uploaded (Caveat's file, under its own name), in a
// family nobody uploaded (falls back to Inter) and in the bundled Caveat. The uploaded one must come out as Caveat,
// not as the fallback. Runs only with REAL_RENDER=1 (FONT_FRAME=<png> keeps the frame).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addItem, createProject, createTextItem, type Project } from '@producer/core'
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
const CAVEAT = path.resolve(__dirname, '../../../../node_modules/@fontsource/caveat/files/caveat-latin-600-normal.woff2')
let client: Client
let workspaceId = ''
let userId = ''

beforeAll(async () => {
  if (!REAL) return
  const t = await setup()
  const A = await signup(t.app, 'Typesetter')
  client = A.client
  workspaceId = A.workspaceId
  userId = (await A.client.json('GET', '/api/auth/me')).body.user.id
}, 300_000)

describe.skipIf(!REAL)('an uploaded brand font, exported', () => {
  it('draws the text in the uploaded font, not the fallback', async () => {
    const up = await client.req('POST', `/api/workspaces/${workspaceId}/brand/fonts?family=Brand%20Scribble&weight=600`, fs.readFileSync(CAVEAT), { 'content-type': 'font/woff2' })
    expect(up.status).toBe(200)

    const r = await client.json('POST', '/api/projects', { workspaceId, name: 'Fonts', width: 1280, height: 720 })
    let p: Project = { ...createProject({ id: r.body.project.id, name: 'Fonts', width: 1280, height: 720, fps: 30 }), background: '#ffffff', createdAt: Date.now() }
    const line = (family: string, y: number) => {
      const t = createTextItem(0, 'heading', { text: 'Wavy Brand Mark', duration: 2, transform: { x: 0, y, scale: 1, rotation: 0 } })
      t.style = { ...t.style, color: '#000000', fontSize: 110, fontFamily: family, fontWeight: 600, shadow: undefined, stroke: undefined, background: undefined } as never
      return t
    }
    p = addItem(p, line('Brand Scribble', -220))
    p = addItem(p, line('Nobody Uploaded This', 0))
    p = addItem(p, line('Caveat', 220))
    const saved = await client.json('PUT', `/api/projects/${r.body.project.id}`, { project: p, baseVersion: r.body.version })
    expect(saved.status).toBe(200)

    const j = await enqueue('export.render', { projectId: r.body.project.id, resolution: '720p', fps: 30, quality: 'standard', format: 'mp4' }, { workspaceId, userId, projectId: r.body.project.id })
    const result = await exportRender(inlineContext(await claimJob(j.id)))
    const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, (result as { exportId: string }).exportId)))[0]
    const out = (await ctx().db.select().from(assets).where(eq(assets.id, ex.assetId)))[0]
    const frame = process.env.FONT_FRAME || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-font-')), 'frame.png')
    await ffmpeg(['-ss', '1', '-i', ctx().storage.localPath!(out.sourceKey), '-frames:v', '1', frame])
    const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true })

    // the ink of a line: its left and right edges and how many dark pixels it has, in a band around its centre
    const ink = (cy: number) => {
      let left = info.width
      let right = -1
      let dark = 0
      for (let y = Math.round(cy - 70); y < cy + 70; y++)
        for (let x = 0; x < info.width; x++) {
          const i = (y * info.width + x) * info.channels
          if (data[i] + data[i + 1] + data[i + 2] < 300) {
            dark++
            if (x < left) left = x
            if (x > right) right = x
          }
        }
      return { width: right - left, dark }
    }
    const cy = info.height / 2
    const uploaded = ink(cy - 220)
    const fallback = ink(cy)
    const caveat = ink(cy + 220)
    console.log(JSON.stringify({ uploaded, fallback, caveat, frame }))
    // every line drew something
    for (const l of [uploaded, fallback, caveat]) expect(l.dark).toBeGreaterThan(500)
    // the uploaded family is drawn with Caveat's shapes (within a few per cent), and not as the fallback is
    expect(Math.abs(uploaded.width - caveat.width) / caveat.width).toBeLessThan(0.04)
    expect(Math.abs(uploaded.dark - caveat.dark) / caveat.dark).toBeLessThan(0.08)
    expect(Math.abs(uploaded.width - fallback.width) / fallback.width).toBeGreaterThan(0.1)
  }, 900_000)
})
