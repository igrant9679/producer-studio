// Upload processing makes media the editor and the export can use, from real files made here with ffmpeg: slow-motion
// and cover-art clips (PIP-25), phone photos with a rotation tag (PIP-9), long uploads that show their thumbnail and
// progress early (PIP-16), browser WebM recordings with no length in their header (PIP-17).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ctx } from '../context'
import { inlineContext } from '../jobs/worker'
import * as proc from '../media/proc'
import { exifOrientation, processAsset, renderMediaKey, sdrStillArgs } from '../media/process'
import { variantTarget } from '../routes/assets'
import { reverseRange } from '../render/export'
import { assetDoc, assetRecord } from '../dto'
import { assets } from '../db/schema'
import { eq } from 'drizzle-orm'
import { type AssetRow, createAssetFromFile, loadAsset } from '../services/assets'
import { type Client, setup, signup } from './helpers'

const { ffmpeg, runOk } = proc
let workspaceId = ''
let userId = ''
let dir = ''
let client: Client

const jc = () => inlineContext({ id: 'proc-test', kind: 'asset.process', workspaceId, userId, projectId: null, input: {} })

/** A file made by ffmpeg in the test folder. */
async function make(name: string, args: string[]): Promise<string> {
  const file = path.join(dir, name)
  await ffmpeg([...args, file])
  return file
}

const upload = (file: string, mime: string, kind: 'video' | 'audio' | 'image' = 'video') =>
  createAssetFromFile({ workspaceId, userId, filePath: file, name: path.basename(file), mime, kind, origin: 'upload' })

async function processFile(file: string, mime: string, kind: 'video' | 'audio' | 'image' = 'video', progress?: (p: number, m?: string) => void): Promise<AssetRow> {
  const a = await upload(file, mime, kind)
  return processAsset(a.id, { ...jc(), ...(progress ? { progress } : {}) })
}

const stored = (key: string | null | undefined) => ctx().storage.localPath!(key!)

interface Stream {
  codec_type: string
  width?: number
  height?: number
  avg_frame_rate?: string
  nb_frames?: string
  codec_name?: string
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

/** Copy a JPEG with an EXIF block saying how to turn it (as phones store portrait photos: sideways + a tag). */
function withOrientation(jpeg: string, out: string, orientation: number, bigEndian = false) {
  const tiff = Buffer.alloc(26)
  const u16 = (v: number, o: number) => (bigEndian ? tiff.writeUInt16BE(v, o) : tiff.writeUInt16LE(v, o))
  const u32 = (v: number, o: number) => (bigEndian ? tiff.writeUInt32BE(v, o) : tiff.writeUInt32LE(v, o))
  tiff.write(bigEndian ? 'MM' : 'II', 0, 'latin1')
  u16(42, 2)
  u32(8, 4)
  u16(1, 8) // one entry: Orientation, SHORT, count 1
  u16(0x0112, 10)
  u16(3, 12)
  u32(1, 14)
  u16(orientation, 18)
  u32(0, 22)
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const head = Buffer.alloc(4)
  head.writeUInt16BE(0xffe1, 0)
  head.writeUInt16BE(body.length + 2, 2)
  const src = fs.readFileSync(jpeg)
  fs.writeFileSync(out, Buffer.concat([src.subarray(0, 2), head, body, src.subarray(2)]))
  return out
}

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app, 'Processor')
  client = u.client
  workspaceId = u.workspaceId
  userId = (await u.client.json('GET', '/api/auth/me')).body.user.id
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-proc-'))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
afterEach(() => vi.restoreAllMocks())

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

describe('phone photos with a rotation tag (PIP-9)', () => {
  it('get their upright size, so preview and export draw them unsquashed, and an upright thumbnail', async () => {
    const landscape = await make('stored.jpg', ['-f', 'lavfi', '-i', 'testsrc2=size=400x200', '-frames:v', '1'])
    const photo = withOrientation(landscape, path.join(dir, 'portrait.jpg'), 6)
    const row = await processFile(photo, 'image/jpeg', 'image')
    expect(row.kind).toBe('image')
    expect(row.meta).toMatchObject({ width: 200, height: 400 })
    const thumb = (await streamsOf(stored(row.thumbKey)))[0]
    expect(thumb).toMatchObject({ width: 200, height: 400 })
  })

  it('reads the tag in either byte order, and leaves untagged or upright photos as they are', async () => {
    const landscape = await make('stored-2.jpg', ['-f', 'lavfi', '-i', 'testsrc2=size=400x200', '-frames:v', '1'])
    expect(exifOrientation(withOrientation(landscape, path.join(dir, 'mm.jpg'), 8, true))).toBe(8)
    expect(exifOrientation(withOrientation(landscape, path.join(dir, 'up.jpg'), 1))).toBe(1)
    expect(exifOrientation(landscape)).toBeUndefined()
    const turned = await processFile(withOrientation(landscape, path.join(dir, 'turned.jpg'), 3), 'image/jpeg', 'image')
    expect(turned.meta).toMatchObject({ width: 400, height: 200 })
  })
})

describe('long uploads (PIP-16)', () => {
  it('save the thumbnail before any full decode, build the filmstrip from 10 seeks, and report progress while decoding', async () => {
    const clip = await make('long.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'])
    const a = await upload(clip, 'video/mp4')
    // what the clip row holds when each ffmpeg step starts
    const real = proc.ffmpeg
    const steps: Array<{ args: string[]; thumbKey: string | null; filmstripKey: string | null }> = []
    vi.spyOn(proc, 'ffmpeg').mockImplementation(async (args, opts) => {
      const row = await loadAsset(a.id)
      steps.push({ args, thumbKey: row.thumbKey, filmstripKey: row.filmstripKey })
      return real(args, opts)
    })
    const progress: Array<[number, string | undefined]> = []
    const row = await processAsset(a.id, { ...jc(), progress: (p, m) => void progress.push([p, m]) })
    expect(row.status).toBe('ready')
    const strip = steps.find((s) => s.args.some((x) => /hstack|tile=/.test(x)))!
    const waveform = steps.find((s) => s.args.some((x) => /silencedetect/.test(x)))!
    // the library has a thumbnail while the filmstrip and the sound are still being worked on
    expect(strip.thumbKey).toBeTruthy()
    expect(waveform.thumbKey).toBeTruthy()
    expect(waveform.filmstripKey).toBeTruthy()
    // the filmstrip seeks to its 10 frames instead of decoding the whole clip again
    expect(strip.args.filter((x) => x === '-ss')).toHaveLength(10)
    expect((await streamsOf(stored(row.filmstripKey)))[0]).toMatchObject({ width: 10 * 284, height: 160 })
    // the waveform pass moves the bar, not just its start
    expect(new Set(progress.filter(([, m]) => m === 'Waveform').map(([p]) => p)).size).toBeGreaterThan(2)
    expect(progress.map(([p]) => p)).toEqual([...progress.map(([p]) => p)].sort((x, y) => x - y))
  })
})

describe('browser recordings (PIP-17)', () => {
  it('a WebM with no length in its header gets its duration, and the proxy reports real progress', async () => {
    // MediaRecorder / Loom style: written live, so no duration and no cues
    const clip = await make('recording.webm', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', '-live', '1', '-f', 'webm'])
    const header = await runOk(ctx().config.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip])
    expect(header.stdout.trim()).toBe('N/A')
    const progress: Array<[number, string | undefined]> = []
    const row = await processFile(clip, 'video/webm', 'video', (p, m) => void progress.push([p, m]))
    expect(row.meta.duration).toBeGreaterThan(2.9)
    expect(row.meta.duration).toBeLessThan(3.1)
    expect(Math.max(...progress.filter(([, m]) => m === 'Building edit proxy').map(([p]) => p))).toBeGreaterThan(0.5)
  })

  it('an audio-only WebM gets its duration too', async () => {
    const clip = await make('voice-note.webm', ['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '2', '-c:a', 'libopus', '-live', '1', '-f', 'webm'])
    const row = await processFile(clip, 'audio/webm', 'audio')
    expect(row.meta.duration).toBeGreaterThan(1.9)
    expect(row.meta.duration).toBeLessThan(2.1)
  })
})

/** The average colour of a picture's first frame, as 8-bit RGB. */
async function rgbOf(file: string): Promise<[number, number, number]> {
  const out = path.join(dir, `px-${Math.random().toString(36).slice(2)}.rgb`)
  await ffmpeg(['-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out])
  const [r, g, b] = fs.readFileSync(out)
  return [r, g, b]
}

describe('iPhone HDR footage (PIP-13)', () => {
  for (const [label, trc] of [
    ['HLG', 'arib-std-b67'],
    ['PQ', 'smpte2084'],
  ] as const) {
    it(`${label}: the proxy, thumbnail, filmstrip and freeze frames are tone-mapped, not washed out`, async () => {
      // a red frame encoded the way an iPhone records: 10-bit BT.2020 with an HDR transfer
      const clip = await make(`hdr-${label}.mp4`, [
        '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1',
        '-vf', `format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt2020:t=${trc}:m=bt2020nc:r=tv,format=yuv420p10le`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-color_primaries', 'bt2020', '-color_trc', trc, '-colorspace', 'bt2020nc',
      ])
      const row = await processFile(clip, 'video/mp4')
      for (const file of [stored(row.thumbKey), stored(row.filmstripKey), stored(row.proxyKey)]) {
        const [r, g] = await rgbOf(file)
        // read as SDR, the 10-bit values come out a greyish brown (about 130, 65, 45)
        expect(g).toBeLessThan(35)
        expect(r).toBeGreaterThan(4 * g + 60)
      }
      expect((await streamsOf(stored(row.proxyKey))).find((s) => s.codec_type === 'video')?.color_transfer).toBe('bt709')
      // the export's freeze-frame and held stills take the same filters, and so does a reversed copy
      const still = await sdrStillArgs(clip)
      expect(still.join(' ')).toMatch(/-vf .*tonemap/)
      const rev = path.join(dir, `rev-${label}.mp4`)
      await reverseRange(clip, rev, { from: 0, to: 1 }, { fps: 30, toneMap: still[1] })
      const [r, g] = await rgbOf(rev)
      expect(g).toBeLessThan(35)
      expect(r).toBeGreaterThan(4 * g + 60)
    })
  }

  it('SDR footage is left as it is', async () => {
    const clip = await make('sdr.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'])
    expect(await sdrStillArgs(clip)).toEqual([])
  })
})

describe('formats browsers cannot play (PIP-24)', () => {
  for (const [name, mime, args] of [
    ['take.aiff', 'audio/aiff', ['-c:a', 'pcm_s16be']],
    ['memo.wma', 'audio/x-ms-wma', ['-c:a', 'wmav2']],
    ['call.amr', 'audio/amr', ['-ar', '8000', '-ac', '1', '-c:a', 'libopencore_amrnb', '-b:a', '12.2k']],
  ] as const) {
    it(`${name} gets an AAC copy the editor plays`, async () => {
      const file = await make(name, ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1.5', ...args])
      const row = await processFile(file, mime, 'audio')
      expect(row.status).toBe('ready')
      expect(row.audioKey).toBeTruthy()
      expect((await streamsOf(stored(row.audioKey))).find((s) => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac' })
      expect(assetDoc(row).proxySrc).toBe(`/api/media/${row.id}/proxy`)
      expect(variantTarget(row, 'proxy')).toMatchObject({ key: row.audioKey, contentType: 'audio/mp4' })
      // the export mixes sound with ffmpeg, which reads the original
      expect(renderMediaKey(row)).toBe(row.sourceKey)
    })
  }

  it('a TIFF gets a PNG copy the editor and the export draw', async () => {
    const file = await make('scan.tiff', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180', '-frames:v', '1', '-c:v', 'tiff'])
    const row = await processFile(file, 'image/tiff', 'image')
    expect(row.status).toBe('ready')
    expect(row.proxyKey).toBeTruthy()
    expect((await streamsOf(stored(row.proxyKey)))[0]).toMatchObject({ codec_name: 'png', width: 320, height: 180 })
    expect(assetDoc(row).proxySrc).toBe(`/api/media/${row.id}/proxy`)
    expect(variantTarget(row, 'proxy')).toMatchObject({ key: row.proxyKey, contentType: 'image/png' })
    expect(renderMediaKey(row)).toBe(row.proxyKey)
  })

  it('an MP3, a WAV and a JPEG are used as they are', async () => {
    const mp3 = await processFile(await make('song.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1']), 'audio/mpeg', 'audio')
    const wav = await processFile(await make('voice.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1']), 'audio/wav', 'audio')
    const jpg = await processFile(await make('photo.jpg', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180', '-frames:v', '1']), 'image/jpeg', 'image')
    for (const row of [mp3, wav, jpg]) {
      expect(row.audioKey ?? row.proxyKey ?? null).toBeNull()
      expect(assetDoc(row).proxySrc).toBeUndefined()
      expect(renderMediaKey(row)).toBe(row.sourceKey)
    }
  })
})

describe('waveforms of long recordings (PIP-14)', () => {
  const getWaveform = async (id: string) => {
    const res = await client.req('GET', `/api/media/${id}/waveform`)
    return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) }
  }

  it('the clip keeps about 4,000 peaks; the full waveform is a file the editor can fetch', async () => {
    // 10 minutes: 30,000 peaks at 50 a second
    const file = await make('lecture.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=8000', '-t', '600', '-ac', '1'])
    const row = await processFile(file, 'audio/wav', 'audio')
    expect(row.meta.duration).toBeCloseTo(600, 0)
    expect(row.meta.waveform!.length).toBeLessThanOrEqual(4000)
    expect(row.meta.waveform!.length).toBeGreaterThan(3000)
    expect(row.meta.waveformRate).toBeCloseTo(row.meta.waveform!.length / 600, 1)
    const doc = assetDoc(row)
    expect(doc.waveformSrc).toBe(`/api/media/${row.id}/waveform`)
    // the record that rides in projects, job results and live updates stays small
    expect(JSON.stringify(assetRecord(row)).length).toBeLessThan(40_000)
    const full = await getWaveform(row.id)
    expect(full.status).toBe(200)
    expect(full.bytes.length).toBeGreaterThanOrEqual(29_990)
    // lavfi's sine is at 1/8 of full scale
    expect(Math.max(...full.bytes.subarray(1000, 2000))).toBe(32)
  })

  it('a short clip keeps its whole waveform inline, as before', async () => {
    const row = await processFile(await make('short.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220', '-t', '3']), 'audio/wav', 'audio')
    expect(row.meta.waveform!.length).toBe(150)
    expect(assetDoc(row)).toMatchObject({ waveformRate: 50 })
    expect(assetDoc(row).waveformSrc).toBeUndefined()
  })

  it('a clip processed before keeps working: its record is shortened, and the full waveform comes from its metadata', async () => {
    const row = await processFile(await make('older.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220', '-t', '3']), 'audio/wav', 'audio')
    // fixture: an hour-long clip from before, with every peak in its metadata
    const peaks = Array.from({ length: 180_000 }, (_, i) => (i % 2 === 0 ? 1 : 0.1))
    await ctx().db.update(assets).set({ meta: { ...row.meta, duration: 3600, waveform: peaks, waveformRate: undefined, waveformFull: undefined } }).where(eq(assets.id, row.id))
    const old = await loadAsset(row.id)
    const doc = assetDoc(old)
    expect(doc.waveform!.length).toBeLessThanOrEqual(4000)
    expect(doc.waveformRate).toBeCloseTo(doc.waveform!.length / 3600, 2)
    expect(doc.waveform!.every((p) => p === 1)).toBe(true) // each window's loudest
    expect(doc.waveformSrc).toBe(`/api/media/${row.id}/waveform`)
    const full = await getWaveform(row.id)
    expect(full.status).toBe(200)
    expect(full.bytes.length).toBe(180_000)
    expect([full.bytes[0], full.bytes[1]]).toEqual([255, 26])
  })
})
