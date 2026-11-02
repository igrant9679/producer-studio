// Animation scenes and free stock photos, for real: illustrations found on Iconify and drawn by sharp, a photo found
// in the free libraries, a scene in every animation style, exported by HyperFrames, and a contact sheet of the frames
// written for a person to look at (ANIMATION_SHEET=<file>). Runs only with REAL_RENDER=1, and needs the network.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProject, type Asset, type Project, type ScriptScene } from '@producer/core'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProducerTimeline } from '../ai/produce'
import { downloadStock, findIllustration, illustrationPng, searchStock } from '../ai/generate'
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

beforeAll(async () => {
  if (!REAL) return
  const t = await setup()
  ctx().config.freeMedia = true
  const A = await signup(t.app, 'Animator')
  client = A.client
  workspaceId = A.workspaceId
  userId = (await A.client.json('GET', '/api/auth/me')).body.user.id
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-anim-'))
}, 300_000)

const job = () => inlineContext({ id: 'c', kind: 'asset.process', workspaceId, userId, projectId: null, input: {} })

async function asset(file: string, name: string, mime: string): Promise<Asset> {
  const created = await createAssetFromFile({ workspaceId, userId, filePath: file, name, mime, kind: 'image', origin: 'stock' })
  return assetDoc(await processAsset(created.id, job()))
}

describe.skipIf(!REAL)('animation scenes, exported', () => {
  it('every style, and a free stock photo, render as they should', async () => {
    const names = ['delivery truck', 'house', 'gift', 'rocket', 'globe', 'money bag']
    const art = new Map<string, Asset>()
    for (const n of names) {
      const found = await findIllustration(n)
      expect(found, n).not.toBeNull()
      const png = await illustrationPng(found!.svg, dir)
      art.set(n, await asset(png.file, `${n} (illustration)`, png.mime))
    }
    const photos = await searchStock({ query: 'wheat field', aspect: '16:9', media: 'photo' })
    expect(photos.length).toBeGreaterThan(0)
    // as assembly does: the first of the first few that downloads
    let got: Awaited<ReturnType<typeof downloadStock>> | undefined
    let pickIndex = 0
    for (; pickIndex < Math.min(3, photos.length) && !got; pickIndex++) got = await downloadStock(photos[pickIndex], dir).catch(() => undefined)
    expect(got).toBeDefined()
    photos[0] = photos[pickIndex - 1]
    const photo = await asset(got!.file, 'wheat field', got!.mime)
    const obj = (name: string, label?: string) => ({ name, ...(label ? { label } : {}), assetId: art.get(name)!.id })
    const scenes: ScriptScene[] = [
      { id: 's01', title: 'Row', headline: 'What you get', narration: 'A truck, a house and a gift.', footage: [], visual: { kind: 'animation', style: 'row', objects: [obj('delivery truck', 'Fast'), obj('house', 'Home'), obj('gift', 'Gift')] } },
      { id: 's02', title: 'Journey', headline: 'How it gets to you', narration: 'The truck leaves, passes the house and brings the gift.', footage: [], visual: { kind: 'animation', style: 'journey', objects: [obj('delivery truck'), obj('house', 'Home'), obj('gift', 'Gift')] } },
      { id: 's03', title: 'Orbit', headline: 'All around the world', narration: 'The globe, with rockets and money all around it.', footage: [], visual: { kind: 'animation', style: 'orbit', objects: [obj('globe', 'Earth'), obj('rocket'), obj('money bag'), obj('gift')] } },
      { id: 's04', title: 'Grow', headline: 'It grows', narration: 'A gift, then a house, then a rocket.', footage: [], visual: { kind: 'animation', style: 'grow', objects: [obj('gift', 'Start'), obj('house', 'Grow'), obj('rocket', 'Launch')] } },
      { id: 's05', title: 'Burst', headline: 'One idea, many results', narration: 'One rocket, and out comes money and gifts.', footage: [], visual: { kind: 'animation', style: 'burst', objects: [obj('rocket', 'Idea'), obj('money bag'), obj('gift')] } },
      { id: 's06', title: 'Change', headline: 'Before and after', narration: 'The house becomes a rocket.', footage: [], visual: { kind: 'animation', style: 'change', objects: [obj('house', 'Before'), obj('rocket', 'After')] } },
      { id: 's07', title: 'Photo', headline: 'Grown with care', narration: 'Grown with care in open fields.', footage: [], visual: { kind: 'photo', query: 'wheat field', assetId: photo.id, credit: { author: photos[0].author, url: photos[0].pageUrl, source: photos[0].source, ...(photos[0].licence ? { licence: photos[0].licence } : {}) } } },
    ]
    const r = await client.json('POST', '/api/projects', { workspaceId, name: 'Animations', width: 1920, height: 1080 })
    const built: Project = buildProducerTimeline({
      project: { ...createProject({ id: r.body.project.id, name: 'Animations' }), createdAt: Date.now() },
      brief: { title: 'Animations', audience: '', goal: '', tone: 'warm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9', source: 'idea' },
      scenes,
      footage: new Map(),
      voices: new Map(),
      generated: new Map([['s07', photo]]),
      illustrations: new Map([...art.values()].map((a) => [a.id, a])),
    })
    const saved = await client.json('PUT', `/api/projects/${r.body.project.id}`, { project: built, baseVersion: r.body.version })
    expect(saved.status).toBe(200)
    const j = await enqueue('export.render', { projectId: r.body.project.id, resolution: '720p', fps: 30, quality: 'standard', format: 'mp4' }, { workspaceId, userId, projectId: r.body.project.id })
    const result = await exportRender(inlineContext(await claimJob(j.id)))
    const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, (result as { exportId: string }).exportId)))[0]
    const out = (await ctx().db.select().from(assets).where(eq(assets.id, ex.assetId)))[0]
    const file = ctx().storage.localPath!(out.sourceKey)
    // three frames of each scene: arriving, moving, settled
    const main = built.tracks.find((t) => t.main)!
    const shots: number[] = []
    for (const sc of scenes) {
      const piece = main.items.find((i) => i.name?.startsWith(`${sc.id} ·`))!
      for (const u of [0.3, 0.55, 0.85]) shots.push(piece.start + piece.duration * u)
    }
    const frames: string[] = []
    for (const [i, t] of shots.entries()) {
      const f = path.join(dir, `f${String(i).padStart(2, '0')}.png`)
      await ffmpeg(['-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', f])
      frames.push(f)
    }
    const sheet = process.env.ANIMATION_SHEET || path.join(dir, 'sheet.png')
    await ffmpeg(['-framerate', '1', '-i', path.join(dir, 'f%02d.png'), '-vf', 'tile=3x7:padding=6:color=white', '-frames:v', '1', sheet])
    console.log(JSON.stringify({ export: file, sheet }))
    // frames differ across a scene: things move
    const a = fs.readFileSync(frames[3])
    const b = fs.readFileSync(frames[4])
    expect(a.equals(b)).toBe(false)
  }, 1_500_000)
})
