// The preview and a real export show the same colours (carried from release 3). Runs only with REAL_RENDER=1: it
// renders with HyperFrames and Chrome (a minute or two) and reads the preview's pixels in Chrome too.
//
// The seed's Sample A (ffmpeg's testsrc2, written without a colour tag) is processed; the editor's preview is the
// proxy drawn by Chrome onto a canvas; the export is decoded the way a player shows it. Before the fix the proxy was
// untagged and Chrome read it as BT.709 (green 216) while the export read BT.601 (green 254). A BT.709 camera file
// went wrong the other way. Both now match.
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { addAsset, addItem, createProject, createVideoItem, type Project } from '@producer/core'
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
import { SOURCE_PREP } from '../render/sources'
import { createAssetFromFile } from '../services/assets'
import { claimJob, type Client, setup, signup } from './helpers'

const REAL = process.env.REAL_RENDER === '1'
let client: Client
let workspaceId = ''
let userId = ''
let dir = ''

/** RGB of `file` at time `t`, pixel (x, y), as a player decodes it (ffmpeg honours the file's tag). */
async function playerPixel(file: string, t: number, x: number, y: number): Promise<number[]> {
  const out = path.join(dir, `px-${Math.random().toString(36).slice(2)}.rgb`)
  await ffmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', out])
  return [...fs.readFileSync(out)]
}

/** RGB Chrome draws for `file` at time `t`, pixel (x, y): the editor's preview of it. */
async function chromePixel(file: string, t: number, x: number, y: number): Promise<number[]> {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<!doctype html><video id="v" src="/clip.mp4" muted playsinline></video>')
    }
    const body = fs.readFileSync(file)
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { default: puppeteer } = (await import('puppeteer-core' as string)) as { default: { launch: (o: unknown) => Promise<any> } }
  const browser = await puppeteer.launch({ executablePath: ctx().config.chromePath, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
    return await page.evaluate(
      async (o: { t: number; x: number; y: number }) => {
        const v = document.getElementById('v') as HTMLVideoElement
        if (v.readyState < 2) await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }))
        v.currentTime = o.t
        await new Promise((r) => v.addEventListener('seeked', r, { once: true }))
        const c = document.createElement('canvas')
        c.width = v.videoWidth
        c.height = v.videoHeight
        const g = c.getContext('2d')!
        g.drawImage(v, 0, 0)
        return Array.from(g.getImageData(o.x, o.y, 1, 1).data).slice(0, 3)
      },
      { t, x, y },
    )
  } finally {
    await browser.close()
    server.close()
  }
}

/** A place in the middle of a patch where the source (read with `matrix`) is a saturated green (or red, or blue). */
async function greenSpot(source: string, t: number, matrix = 'bt601', channel = 1): Promise<{ x: number; y: number }> {
  const out = path.join(dir, 'frame.rgb')
  await ffmpeg(['-ss', String(t), '-i', source, '-frames:v', '1', '-vf', `scale=in_color_matrix=${matrix}:in_range=tv,format=rgb24`, '-f', 'rawvideo', out])
  const px = fs.readFileSync(out)
  const W = 1280
  const at = (x: number, y: number) => [px[(y * W + x) * 3], px[(y * W + x) * 3 + 1], px[(y * W + x) * 3 + 2]]
  for (let y = 40; y < 680; y += 8)
    for (let x = 40; x < 1240; x += 8) {
      const ok = (q: number[]) => q[channel] > 200 && q.every((v, c) => c === channel || v < 60)
      // the middle of a patch, not an edge
      if ([at(x, y), at(x - 16, y), at(x + 16, y), at(x, y - 16), at(x, y + 16), at(x - 16, y - 16), at(x + 16, y + 16)].every(ok)) return { x, y }
    }
  throw new Error(`no patch of colour ${channel} in the test pattern`)
}

beforeAll(async () => {
  if (!REAL) return
  const t = await setup()
  const u = await signup(t.app, 'Colourist')
  client = u.client
  workspaceId = u.workspaceId
  userId = (await u.client.json('GET', '/api/auth/me')).body.user.id
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-colour-'))
}, 300_000)

async function exportOf(file: string, name: string, size: { w: number; h: number }) {
  const created = await createAssetFromFile({ workspaceId, userId, filePath: file, name, mime: 'video/mp4', kind: 'video', origin: 'upload' })
  const row = await processAsset(created.id, inlineContext({ id: 'c', kind: 'asset.process', workspaceId, userId, projectId: null, input: {} }))
  const r = await client.json('POST', '/api/projects', { workspaceId, name: `Colour ${name}`, width: size.w, height: size.h })
  let p = r.body.project as Project
  const a = assetDoc(row)
  p = addAsset(p, a)
  p = addItem(p, createVideoItem(a, 0, { duration: 2 }))
  await client.json('PUT', `/api/projects/${r.body.project.id}`, { project: p, baseVersion: r.body.version })
  const job = await enqueue('export.render', { projectId: r.body.project.id, resolution: '720p', fps: 30, quality: 'standard', format: 'mp4' }, { workspaceId, userId, projectId: r.body.project.id })
  const result = await exportRender(inlineContext(await claimJob(job.id)))
  const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, (result as { exportId: string }).exportId)))[0]
  const out = (await ctx().db.select().from(assets).where(eq(assets.id, ex.assetId)))[0]
  return { row, file: ctx().storage.localPath!(out.sourceKey), proxy: ctx().storage.localPath!(row.proxyKey!) }
}

describe.skipIf(!REAL)('the preview and a real export show the same colours', () => {
  it("the seed's Sample A (untagged, made by ffmpeg)", async () => {
    // exactly as the seed makes it
    const file = path.join(dir, 'sample-a.mp4')
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file])
    const t = 1
    const { x, y } = await greenSpot(file, t)
    const e = await exportOf(file, 'Sample A — test pattern.mp4', { w: 1280, h: 720 })
    const preview = await chromePixel(e.proxy, t, x, y)
    const exported = await playerPixel(e.file, t, x, y)
    // the proxy as processing made it before (no colour tag), as this Chrome shows it
    const untagged = path.join(dir, 'old-proxy.mp4')
    await ffmpeg(['-i', file, '-vf', 'scale=1280:720,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '30', '-an', untagged])
    const before = await chromePixel(untagged, t, x, y)
    console.log(JSON.stringify({ test: 'sample A', spot: { x, y }, previewBefore: before, preview, export: exported }))
    expect(Math.abs(preview[1] - exported[1])).toBeLessThanOrEqual(6)
    expect(Math.abs(preview[0] - exported[0])).toBeLessThanOrEqual(8)
    // (whether this Chrome read the untagged proxy as BT.709, as the editor's did, is printed above: headless Chrome's
    // software decoder may read it as BT.601; the tag now decides, in any Chrome)
    void before
  }, 1_500_000)

  it('a BT.709 camera file (tagged)', async () => {
    const file = path.join(dir, 'camera-709.mp4')
    // still bars of red, green, blue and a skin-like orange, made in BT.709 and tagged so (a camera file)
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=320x720:r=30', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x720:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=320x720:r=30', '-f', 'lavfi', '-i', 'color=c=0xd08040:s=320x720:r=30', '-t', '4', '-filter_complex', 'hstack=inputs=4,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:v', 'libx264', '-preset', 'veryfast', file])
    const t = 1
    const spots: Array<{ x: number; y: number } | undefined> = [160, 480, 800, 1120].map((x) => ({ x, y: 360 }))
    const e = await exportOf(file, 'camera.mp4', { w: 1280, h: 720 })
    // the export as it was, without the conversion
    SOURCE_PREP.colour = false
    const old = await exportOf(file, 'camera-old.mp4', { w: 1280, h: 720 }).finally(() => (SOURCE_PREP.colour = true))
    const diff = (a: number[], b: number[]) => Math.max(...a.map((v, c) => Math.abs(v - b[c])))
    let after = 0
    let was = 0
    for (const spot of spots.filter((x): x is { x: number; y: number } => !!x)) {
      const preview = await chromePixel(e.proxy, t, spot.x, spot.y)
      const exported = await playerPixel(e.file, t, spot.x, spot.y)
      const before = await playerPixel(old.file, t, spot.x, spot.y)
      console.log(JSON.stringify({ test: 'bt709', spot, preview, export: exported, exportBefore: before }))
      // Chrome also maps BT.709 primaries to the screen's, which a JPEG frame never gets: a few levels on saturated colours
      expect(diff(preview, exported)).toBeLessThanOrEqual(12)
      after += diff(preview, exported)
      was += diff(preview, before)
    }
    expect(after).toBeLessThan(was)
  }, 1_500_000)
})
