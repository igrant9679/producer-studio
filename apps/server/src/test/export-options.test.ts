// Export options (E-5): a range, audio only, burned-in or sidecar captions, a platform shape, the cover frame;
// the quick draft preview (E-23); scene detection for "Split at scene changes" (E-10). Chrome's render is stubbed
// (a copy of a test clip), so these check what is rendered and what is saved, not the pixels.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { addAsset, addItem, createCaptionItem, createProject, createVideoItem, insertTrack, type ExportPreviewResult, type ExportRequest, type ExportResult, type Project, type SceneCuts } from '@producer/core'
import { ctx } from '../context'
import { assets, exportsTable } from '../db/schema'
import { assetDoc } from '../dto'
import { finishJob, getJob } from '../jobs/queue'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { probe, processAsset } from '../media/process'
import { detectScenes, parseSceneCuts } from '../media/scenes'
import { type RenderSteps, audioArgs, coverTime, exportRender, renderPlan } from '../render/export'
import { createAssetFromFile } from '../services/assets'
import { type Client, claimJob, setup, signup } from './helpers'

vi.mock('../media/proc', async (importOriginal) => {
  const m = await importOriginal<typeof import('../media/proc')>()
  return { ...m, ffmpeg: vi.fn(m.ffmpeg) }
})

let client: Client
let workspaceId: string
let userId: string
let clipFile: string
let projectId: string
let version: number
let video: ReturnType<typeof assetDoc>

/** What the stubbed render saw: the composition's length, size and whether caption lines were in it. */
interface Seen {
  duration: number
  width: number
  height: number
  captions: boolean
  fps: number
  quality: string
}
let seen: Seen | undefined
const steps: RenderSteps = {
  lint: async () => ({ errors: [], warnings: 0 }),
  render: async (dir, out, o) => {
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
    const root = html.match(/data-composition-id="main" data-start="0" data-width="(\d+)" data-height="(\d+)" data-duration="([\d.]+)"/)!
    seen = { width: +root[1], height: +root[2], duration: +root[3], captions: html.includes('"type":"caption"'), fps: o.fps, quality: o.quality }
    fs.copyFileSync(clipFile, out)
  },
}

/** Ask for an export through the API, then run the job here with the stubbed render. */
async function exportVia(body: Partial<ExportRequest>): Promise<{ jobId: string; result: ExportResult & ExportPreviewResult }> {
  const r = await client.json('POST', `/api/projects/${projectId}/export`, { resolution: '720p', fps: 30, quality: 'draft', format: 'mp4', ...body })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  const claimed = await claimJob(r.body.id)
  const result = (await exportRender(inlineContext(claimed), steps)) as ExportResult & ExportPreviewResult
  return { jobId: claimed.id, result }
}

async function save(p: Project) {
  const r = await client.json('PUT', `/api/projects/${projectId}`, { project: p, baseVersion: version })
  expect(r.status).toBe(200)
  version = r.body.version
}

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app)
  client = u.client
  workspaceId = u.workspaceId
  userId = (await client.json('GET', '/api/auth/me')).body.user.id
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-expopt-'))
  clipFile = path.join(tmp, 'clip.mp4')
  // three shots (red, blue, the test pattern) with a tone under them
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipFile,
  ])
  const created = await createAssetFromFile({ workspaceId, userId, filePath: clipFile, name: 'shots.mp4', mime: 'video/mp4', kind: 'video', origin: 'upload' })
  video = assetDoc(await processAsset(created.id, inlineContext({ id: 't', kind: 'asset.process', workspaceId, userId, projectId: null, input: {} })))
  const r = await client.json('POST', '/api/projects', { workspaceId, name: 'Options', width: 1280, height: 720 })
  projectId = r.body.project.id
  version = r.body.version
  let p = r.body.project as Project
  p = addAsset(p, video)
  p = addItem(p, createVideoItem(video, 0, { duration: 3 }))
  const cap = insertTrack(p, 'caption')
  cap.items.push(createCaptionItem(0.5, 1, 'first line'), createCaptionItem(2, 0.8, 'second line'))
  await save(p)
})

describe('export a range, a shape, captions and a cover (E-5)', () => {
  it('renders only the range asked for', async () => {
    const { result } = await exportVia({ range: { from: 1, to: 2.5 } })
    expect(seen).toMatchObject({ duration: 1.5, width: 1280, height: 720, captions: true })
    expect(result.format).toBe('mp4')
  })

  it('refuses a range past the end, or one too short', async () => {
    expect((await client.json('POST', `/api/projects/${projectId}/export`, { range: { from: 9, to: 12 } })).status).toBe(400)
    expect((await client.json('POST', `/api/projects/${projectId}/export`, { range: { from: 1, to: 1.05 } })).status).toBe(400)
  })

  it('reframes a copy to a platform shape at the chosen resolution', async () => {
    await exportVia({ aspect: '9:16', resolution: '1080p' })
    expect(seen).toMatchObject({ width: 1080, height: 1920 })
    // the project itself keeps its shape
    expect((await client.json('GET', `/api/projects/${projectId}`)).body.project.width).toBe(1280)
  })

  it('writes sidecar captions instead of drawing them, downloadable beside the export', async () => {
    const { result } = await exportVia({ captions: 'sidecar', captionFormat: 'vtt', range: { from: 1, to: 3 } })
    expect(seen!.captions).toBe(false)
    expect(result.captionsUrl).toBe(`/api/exports/${result.exportId}/captions`)
    const res = await client.req('GET', result.captionsUrl!)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/\.vtt/)
    // the range's times: the second line starts 1 s into this file, the first is cut to its last half second
    expect(await res.text()).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nfirst line\n\n00:00:01.000 --> 00:00:01.800\nsecond line\n')
    const list = (await client.json('GET', `/api/exports?projectId=${projectId}`)).body as ExportResult[]
    expect(list.find((e) => e.exportId === result.exportId)).toMatchObject({ captionsUrl: result.captionsUrl, format: 'mp4' })
    expect(list.filter((e) => e.captionsUrl).length).toBe(1)
  })

  it('leaves captions out altogether, or has none to write', async () => {
    const { result } = await exportVia({ captions: 'none' })
    expect(seen!.captions).toBe(false)
    expect(result.captionsUrl).toBeUndefined()
    // nothing to write in this range: no file
    const r = await exportVia({ captions: 'sidecar', range: { from: 1.6, to: 1.9 } })
    expect(r.result.captionsUrl).toBeUndefined()
    expect((await client.req('GET', `/api/exports/${r.result.exportId}/captions`)).status).toBe(404)
  })

  it('takes the thumbnail at the cover frame picked', async () => {
    vi.mocked(ffmpeg).mockClear()
    await exportVia({ coverAt: 2.2 })
    const thumb = vi.mocked(ffmpeg).mock.calls.map((c) => c[0]).find((a) => a.includes('scale=-2:360'))!
    expect(thumb[thumb.indexOf('-ss') + 1]).toBe('2.2')
    expect(coverTime(undefined, 10)).toBe(1)
    expect(coverTime(99, 3)).toBe(2.95)
  })

  it('a viewer of another space cannot read the caption file', async () => {
    const { result } = await exportVia({ captions: 'sidecar' })
    const other = await signup((await setup()).app, 'Outsider')
    expect([403, 404]).toContain((await other.client.req('GET', result.captionsUrl!)).status)
  })
})

describe('audio-only exports (E-5)', () => {
  for (const format of ['mp3', 'wav'] as const) {
    it(`saves the sound as ${format.toUpperCase()}`, async () => {
      const { result } = await exportVia({ format })
      // rendered small and at a low frame rate: only the sound is kept
      expect(seen).toMatchObject({ height: 144, fps: 10, quality: 'draft' })
      const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, result.exportId)))[0]
      const [a] = await ctx().db.select().from(assets).where(eq(assets.id, ex.assetId))
      expect(a).toMatchObject({ kind: 'audio', mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav' })
      expect(a.name.endsWith(`.${format}`)).toBe(true)
      expect(ex.resolution).toBe('audio')
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-aud-')), `a.${format}`)
      fs.writeFileSync(file, Buffer.from(await (await client.req('GET', result.url)).arrayBuffer()))
      const info = await probe(file)
      expect(info.hasAudio).toBe(true)
      expect(info.width).toBeFalsy()
      expect(info.duration).toBeCloseTo(3, 0)
    })
  }

  it('builds the ffmpeg arguments for each format', () => {
    expect(audioArgs('in.mp4', 'out.mp3', 'mp3', 2.5)).toEqual(['-i', 'in.mp4', '-vn', '-map', '0:a:0', '-t', '2.5', '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'])
    expect(audioArgs('in.mp4', 'out.wav', 'wav', 1)).toContain('pcm_s16le')
  })
})

describe('draft preview of a range (E-23)', () => {
  it('renders small and fast, keeps no export, and plays from the dialog', async () => {
    const before = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.projectId, projectId))).length
    const first = await exportVia({ preview: true, range: { from: 0.5, to: 2 }, resolution: '1080p', quality: 'high', fps: 60 })
    expect(seen).toMatchObject({ height: 360, width: 640, fps: 24, quality: 'draft', duration: 1.5 })
    expect(first.result.previewUrl).toBe(`/api/projects/${projectId}/previews/${first.jobId}`)
    expect((await ctx().db.select().from(exportsTable).where(eq(exportsTable.projectId, projectId))).length).toBe(before)
    // the worker finishes the job with the result: until then the draft isn't served
    expect((await client.req('GET', first.result.previewUrl)).status).toBe(404)
    await finishJob(first.jobId, first.result)
    expect((await getJob(first.jobId))?.status).toBe('done')
    const res = await client.req('GET', first.result.previewUrl)
    expect([res.status, res.headers.get('content-type')]).toEqual([200, 'video/mp4'])
    expect(renderPlan({ width: 1280, height: 720 }, { resolution: '4k', fps: 30, quality: 'high', format: 'gif', preview: true })).toMatchObject({ format: 'mp4', size: { w: 640, h: 360 } })
  })

  it('a new draft replaces the one before, and other spaces cannot see it', async () => {
    const a = await exportVia({ preview: true })
    await finishJob(a.jobId, a.result)
    expect((await client.req('GET', a.result.previewUrl)).status).toBe(200)
    const other = await signup((await setup()).app, 'Outsider')
    expect([403, 404]).toContain((await other.client.req('GET', a.result.previewUrl)).status)
    const b = await exportVia({ preview: true })
    await finishJob(b.jobId, b.result)
    expect((await client.req('GET', a.result.previewUrl)).status).toBe(404)
    expect((await client.req('GET', b.result.previewUrl)).status).toBe(200)
  })
})

describe('scene detection (E-10)', () => {
  it('finds the cuts between shots, inside the range asked for', async () => {
    const r = await client.json('POST', `/api/assets/${video.id}/scenes`, {})
    expect(r.status).toBe(200)
    expect(r.body.kind).toBe('media.scenes')
    const claimed = await claimJob(r.body.id)
    const res: SceneCuts = await detectScenes(inlineContext(claimed))
    expect(res.assetId).toBe(video.id)
    expect(res.cuts.length).toBe(2)
    expect(res.cuts[0]).toBeCloseTo(1, 1)
    expect(res.cuts[1]).toBeCloseTo(2, 1)
    // from 1.5 s on, only the second cut
    const again = await client.json('POST', `/api/assets/${video.id}/scenes`, { from: 1.5, to: 3 })
    const later = await detectScenes(inlineContext(await claimJob(again.body.id)))
    expect(later.cuts.length).toBe(1)
    expect(later.cuts[0]).toBeCloseTo(2, 1)
  })

  it('refuses a bad range and other spaces', async () => {
    expect((await client.json('POST', `/api/assets/${video.id}/scenes`, { from: 2, to: 1 })).status).toBe(400)
    const other = await signup((await setup()).app, 'Outsider')
    expect([403, 404]).toContain((await other.client.json('POST', `/api/assets/${video.id}/scenes`, {})).status)
  })

  it('reads showinfo lines and merges cuts close together', () => {
    const line = (t: number) => `[Parsed_showinfo_2 @ 0x1] n:   0 pts:  30 pts_time:${t} duration: 1`
    expect(parseSceneCuts([line(1), line(1.2), line(2.5)].join('\n'), 10)).toEqual([11, 12.5])
  })
})
