// What processing makes of an upload in phase 5 (release 4), from real files made here with ffmpeg: proxies that
// scrub and look like the footage (P-17), colour matrices the preview and export agree on (carried from R3), uploads
// normalised for every browser (P-19), identical uploads not processed twice (P-21), hardware encoding with a
// software fallback (P-18).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ctx } from '../context'
import { inlineContext } from '../jobs/worker'
import * as proc from '../media/proc'
import { colourTagArgs, videoMatrix } from '../media/colour'
import { encodeH264, h264Args, resetHardwareEncoder } from '../media/hwenc'
import { imageDisplay, PROCESSING_VERSION, pickAudioStream, processAsset, proxyGop, proxySize, scaledImageSize } from '../media/process'
import { variantTarget } from '../routes/assets'
import { type AssetRow, createAssetFromFile } from '../services/assets'
import { setup, signup } from './helpers'

const { ffmpeg, runOk } = proc
let workspaceId = ''
let otherSpace = ''
let userId = ''
let dir = ''

const jc = (ws = workspaceId) => inlineContext({ id: 'pipe-test', kind: 'asset.process', workspaceId: ws, userId, projectId: null, input: {} })

async function make(name: string, args: string[]): Promise<string> {
  const file = path.join(dir, name)
  await ffmpeg([...args, file])
  return file
}

async function processFile(file: string, mime: string, kind: 'video' | 'audio' | 'image' = 'video', ws = workspaceId): Promise<AssetRow> {
  const a = await createAssetFromFile({ workspaceId: ws, userId, filePath: file, name: path.basename(file), mime, kind, origin: 'upload' })
  return processAsset(a.id, jc(ws))
}

const stored = (key: string | null | undefined) => ctx().storage.localPath!(key!)

async function probeJson(file: string, extra: string[] = []): Promise<any> {
  const r = await runOk(ctx().config.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', ...extra, file])
  return JSON.parse(r.stdout)
}
const videoStream = async (file: string) => (await probeJson(file)).streams.find((s: { codec_type: string }) => s.codec_type === 'video')

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app, 'Pipeline')
  workspaceId = u.workspaceId
  userId = (await u.client.json('GET', '/api/auth/me')).body.user.id
  otherSpace = (await u.client.json('POST', '/api/workspaces', { name: 'Other' })).body.id
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-pipe-'))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
afterEach(() => vi.restoreAllMocks())

describe('better proxies (P-17)', () => {
  it('a 4K source gets a 1080p proxy; HD and smaller stay at 720p at most', () => {
    expect(proxySize(3840, 2160)).toEqual({ w: 1920, h: 1080 })
    expect(proxySize(2160, 3840)).toEqual({ w: 1080, h: 1920 })
    expect(proxySize(4096, 2160)).toEqual({ w: 2048, h: 1080 })
    expect(proxySize(1920, 1080)).toEqual({ w: 1280, h: 720 })
    expect(proxySize(2704, 1520)).toEqual({ w: 1280, h: 720 })
    expect(proxySize(640, 360)).toEqual({ w: 640, h: 360 })
  })

  it('a keyframe every half second, so scrubbing lands fast', () => {
    expect(proxyGop(30)).toBe(15)
    expect(proxyGop(60)).toBe(30)
    expect(proxyGop(240)).toBe(30)
    expect(proxyGop(24)).toBe(12)
  })

  it('a real 4K upload: its proxy is 1080p with keyframes half a second apart', async () => {
    const clip = await make('uhd.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'])
    const row = await processFile(clip, 'video/mp4')
    const v = await videoStream(stored(row.proxyKey))
    expect(v).toMatchObject({ width: 1920, height: 1080 })
    const frames = (await probeJson(stored(row.proxyKey), ['-skip_frame', 'nokey', '-select_streams', 'v', '-show_frames', '-show_entries', 'frame=pts_time,best_effort_timestamp_time'])).frames as Array<{ pts_time: string }>
    const keys = frames.map((f) => Number(f.pts_time ?? (f as { best_effort_timestamp_time?: string }).best_effort_timestamp_time))
    expect(keys.length).toBeGreaterThanOrEqual(4)
    expect(keys[1] - keys[0]).toBeCloseTo(0.5, 1)
    expect(row.meta.processing).toBe(PROCESSING_VERSION)
  })
})

describe('colour matrices the preview and the export agree on', () => {
  it('reads the tag; an untagged file ffmpeg wrote is BT.601; other untagged video by its size', () => {
    expect(videoMatrix({ colorSpace: 'bt709', width: 640, height: 360 })).toEqual({ matrix: 'bt709', tagged: true })
    expect(videoMatrix({ encoder: 'Lavf61.7.100', width: 1280, height: 720 })).toEqual({ matrix: 'smpte170m', tagged: false })
    expect(videoMatrix({ encoder: 'Apple QuickTime', width: 1920, height: 1080 })).toEqual({ matrix: 'bt709', tagged: false })
    expect(videoMatrix({ width: 720, height: 480 })).toEqual({ matrix: 'smpte170m', tagged: false })
    expect(colourTagArgs('bt709')).toEqual(['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'])
  })

  it('the proxy says which matrix its pixels are in, so the browser reads them as the export does', async () => {
    // made like the seed's Sample A: ffmpeg, no tag
    const untagged = await make('untagged.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'])
    const a = await processFile(untagged, 'video/mp4')
    expect(a.meta.colorMatrix).toBe('smpte170m')
    expect(await videoStream(stored(a.proxyKey))).toMatchObject({ color_space: 'smpte170m', color_primaries: 'smpte170m' })
    const tagged = await make('tagged.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1', '-vf', 'scale=out_color_matrix=bt709,format=yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:v', 'libx264', '-preset', 'ultrafast'])
    const b = await processFile(tagged, 'video/mp4')
    expect(b.meta.colorMatrix).toBe('bt709')
    expect(await videoStream(stored(b.proxyKey))).toMatchObject({ color_space: 'bt709' })
  })
})

describe('uploads normalised for every browser (P-19)', () => {
  it('the sound used is the first stereo track a decoder can read', () => {
    const s = (index: number, channels: number, codec = 'aac') => ({ index, codec_type: 'audio', codec_name: codec, channels })
    expect(pickAudioStream([{ index: 0, codec_type: 'video' }, s(1, 1), s(2, 2)])?.index).toBe(2)
    expect(pickAudioStream([s(1, 1), s(2, 1)])?.index).toBe(1)
    expect(pickAudioStream([s(1, 2, 'none'), s(2, 1)])?.index).toBe(2)
  })

  it('a recording with a mono mic first and the stereo mix second: the proxy plays the mix', async () => {
    const clip = await make('two-tracks.mov', [
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '1', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-ac:a:1', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    ])
    const row = await processFile(clip, 'video/quicktime')
    const vol = await proc.run(ctx().config.ffmpegPath, ['-hide_banner', '-i', stored(row.audioKey), '-af', 'volumedetect', '-f', 'null', '-'])
    const max = Number(vol.stderr.match(/max_volume:\s*(-?[\d.]+)/)?.[1])
    expect(max).toBeGreaterThan(-30)
  })

  it('a sound file whose mix is not its first track gets a copy of the mix the editor plays', async () => {
    const file = await make('tracks.mka', ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-map', '0:a', '-map', '1:a', '-ac:a:1', '2', '-c:a', 'flac'])
    const row = await processFile(file, 'audio/x-matroska', 'audio')
    expect(row.audioKey).toBeTruthy()
    expect(variantTarget(row, 'proxy')).toMatchObject({ key: row.audioKey })
  })

  it('which pictures get a display copy: undrawable formats, sideways photos, huge ones', () => {
    expect(imageDisplay({ codec: 'mjpeg', width: 4000, height: 3000 })).toBeNull()
    expect(imageDisplay({ codec: 'png', width: 4000, height: 3000 })).toBeNull()
    expect(imageDisplay({ codec: 'av1', width: 400, height: 300 }, 'image/avif')).toBeNull()
    expect(imageDisplay({ codec: 'tiff', width: 400, height: 300 })).toEqual({ format: 'png' })
    expect(imageDisplay({ codec: 'hevc', width: 4032, height: 3024 }, 'image/heic')).toEqual({ format: 'png' })
    expect(imageDisplay({ codec: 'mjpeg', width: 300, height: 400, orientation: 6 })).toEqual({ format: 'jpg' })
    expect(imageDisplay({ codec: 'mjpeg', width: 12000, height: 8000 })).toMatchObject({ format: 'jpg', scale: expect.stringMatching(/^scale=7680:5120/) })
    expect(scaledImageSize(12000, 8000)).toEqual({ width: 7680, height: 5120 })
    // under the side limit, over 40 megapixels
    expect(scaledImageSize(7000, 7000)).toEqual({ width: 6324, height: 6324 })
    expect(scaledImageSize(10000, 2000)).toEqual({ width: 7680, height: 1536 })
  })

  it('a huge picture is drawn from a scaled copy (its size stays the original)', async () => {
    const file = await make('panorama.png', ['-f', 'lavfi', '-i', 'color=c=blue:s=9000x1000', '-frames:v', '1'])
    const row = await processFile(file, 'image/png', 'image')
    expect(row.proxyKey).toMatch(/display\.png$/)
    expect(await videoStream(stored(row.proxyKey))).toMatchObject({ width: 7680, height: 854 })
    expect(row.meta).toMatchObject({ width: 9000, height: 1000, displaySize: { width: 7680, height: 854 } })
  })

  it('a sideways phone photo is drawn from an upright JPEG copy', async () => {
    const landscape = await make('stored.jpg', ['-f', 'lavfi', '-i', 'testsrc2=size=400x200', '-frames:v', '1'])
    // EXIF orientation 6 (turn 90° clockwise), as phones store portrait photos
    const tiff = Buffer.from('4949' + '2a00' + '08000000' + '0100' + '1201' + '0300' + '01000000' + '0600' + '0000' + '00000000', 'hex')
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
    const head = Buffer.from([0xff, 0xe1, 0, 0])
    head.writeUInt16BE(body.length + 2, 2)
    const src = fs.readFileSync(landscape)
    const photo = path.join(dir, 'portrait.jpg')
    fs.writeFileSync(photo, Buffer.concat([src.subarray(0, 2), head, body, src.subarray(2)]))
    const row = await processFile(photo, 'image/jpeg', 'image')
    expect(row.proxyKey).toMatch(/display\.jpg$/)
    expect(await videoStream(stored(row.proxyKey))).toMatchObject({ width: 200, height: 400 })
    expect(variantTarget(row, 'proxy')).toMatchObject({ contentType: 'image/jpeg' })
  })
})

describe('identical uploads are not processed twice (P-21)', () => {
  it('the same file in the same space copies the first clip’s proxy, thumbnails and waveform', async () => {
    const clip = await make('twice.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'])
    const first = await processFile(clip, 'video/mp4')
    const spy = vi.spyOn(proc, 'ffmpeg')
    const second = await processFile(clip, 'video/mp4')
    expect(spy).not.toHaveBeenCalled()
    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe('ready')
    expect(second.meta).toMatchObject({ reusedFrom: first.id, duration: first.meta.duration, width: 640, filmstrip: first.meta.filmstrip })
    expect(second.meta.waveform).toEqual(first.meta.waveform)
    for (const k of ['proxyKey', 'thumbKey', 'filmstripKey', 'audioKey'] as const) {
      expect(second[k]).toContain(second.id)
      expect(fs.readFileSync(stored(second[k])).equals(fs.readFileSync(stored(first[k])))).toBe(true)
    }
    // its own files: the first clip can go without taking them
    fs.rmSync(stored(first.proxyKey))
    expect(fs.existsSync(stored(second.proxyKey))).toBe(true)
  })

  it('another space processes its own copy', async () => {
    const clip = await make('elsewhere.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'])
    await processFile(clip, 'video/mp4')
    const spy = vi.spyOn(proc, 'ffmpeg')
    const there = await processFile(clip, 'video/mp4', 'video', otherSpace)
    expect(spy).toHaveBeenCalled()
    expect(there.meta.reusedFrom).toBeUndefined()
  })
})

describe('hardware encoding (P-18)', () => {
  it('each encoder aims at libx264’s quality with the same keyframe spacing', () => {
    expect(h264Args(null, { crf: 26, gop: 15 })).toEqual(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '15', '-keyint_min', '15'])
    for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'] as const) {
      const a = h264Args(enc, { crf: 26, gop: 15 })
      expect(a.slice(0, 2)).toEqual(['-c:v', enc])
      expect(a).toContain('-g')
    }
  })

  it('an encode the hardware refuses is made again in software, and software is used from then on', async () => {
    resetHardwareEncoder('h264_nvenc')
    const tried: string[] = []
    const go = async (args: string[]) => {
      tried.push(args[1])
      if (args[1] !== 'libx264') throw new Error('No NVENC capable devices found')
    }
    expect(await encodeH264((enc) => h264Args(enc, { crf: 26, gop: 15 }), go)).toBeNull()
    expect(await encodeH264((enc) => h264Args(enc, { crf: 26, gop: 15 }), go)).toBeNull()
    expect(tried).toEqual(['h264_nvenc', 'libx264', 'libx264'])
    resetHardwareEncoder('h264_qsv')
    expect(await encodeH264((enc) => h264Args(enc, { crf: 26, gop: 15 }), async () => undefined)).toBe('h264_qsv')
    resetHardwareEncoder(null)
  })
})
