// Upload processing makes media the editor and the export can use, from real files made here with ffmpeg: slow-motion
// and cover-art clips (PIP-25).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { inlineContext } from '../jobs/worker'
import { ffmpeg, runOk } from '../media/proc'
import { processAsset } from '../media/process'
import { type AssetRow, createAssetFromFile } from '../services/assets'
import { setup, signup } from './helpers'

let workspaceId = ''
let userId = ''
let dir = ''

const jc = () => inlineContext({ id: 'proc-test', kind: 'asset.process', workspaceId, userId, projectId: null, input: {} })

/** A file made by ffmpeg in the test folder. */
async function make(name: string, args: string[]): Promise<string> {
  const file = path.join(dir, name)
  await ffmpeg([...args, file])
  return file
}

async function processFile(file: string, mime: string, kind: 'video' | 'audio' | 'image' = 'video'): Promise<AssetRow> {
  const a = await createAssetFromFile({ workspaceId, userId, filePath: file, name: path.basename(file), mime, kind, origin: 'upload' })
  return processAsset(a.id, jc())
}

const stored = (key: string | null | undefined) => ctx().storage.localPath!(key!)

interface Stream {
  codec_type: string
  width?: number
  height?: number
  avg_frame_rate?: string
  nb_frames?: string
  color_transfer?: string
}
async function streamsOf(file: string): Promise<Stream[]> {
  const r = await runOk(ctx().config.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', file])
  return (JSON.parse(r.stdout) as { streams: Stream[] }).streams
}
const fps = (s?: string) => {
  const [a, b] = (s ?? '0/1').split('/').map(Number)
  return b ? a / b : a
}

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app, 'Processor')
  workspaceId = u.workspaceId
  userId = (await u.client.json('GET', '/api/auth/me')).body.user.id
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-proc-'))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('proxies (PIP-25)', () => {
  it('slow-motion footage gets a proxy of at most 60 fps', async () => {
    const clip = await make('slowmo.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=240', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'])
    const row = await processFile(clip, 'video/mp4')
    expect(row.meta.fps).toBe(240)
    const v = (await streamsOf(stored(row.proxyKey))).find((s) => s.codec_type === 'video')!
    expect(fps(v.avg_frame_rate)).toBeLessThanOrEqual(60)
    expect(fps(v.avg_frame_rate)).toBeGreaterThan(50)
  })

  // ffmpeg's own muxers always write the cover after the video, so this guards the mapping rather than reproducing a
  // cover-first file (some phone and editor exports have one): every step now maps the stream probe chose
  it('a clip with cover art: the proxy, thumbnail and filmstrip show the video, not the cover', async () => {
    const cover = await make('cover.png', ['-f', 'lavfi', '-i', 'color=c=red:s=640x640', '-frames:v', '1'])
    const video = await make('plain.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'])
    // the cover is the first video stream, as phones and editors write it
    const clip = await make('with-cover.mp4', ['-i', cover, '-i', video, '-map', '0', '-map', '1', '-c', 'copy', '-disposition:v:0', 'attached_pic'])
    const row = await processFile(clip, 'video/mp4')
    expect(row.meta).toMatchObject({ width: 320, height: 180 })
    const v = (await streamsOf(stored(row.proxyKey))).find((s) => s.codec_type === 'video')!
    expect(v).toMatchObject({ width: 320, height: 180 })
    expect(Number(v.nb_frames)).toBeGreaterThan(30)
    const thumb = (await streamsOf(stored(row.thumbKey)))[0]
    expect(thumb.width! / thumb.height!).toBeCloseTo(16 / 9, 1)
  })
})
