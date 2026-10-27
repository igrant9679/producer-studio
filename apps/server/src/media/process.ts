// asset.process: probe, H.264 proxy ≤720p, thumbnail, filmstrip sprite, waveform peaks, silence detection, audio extract.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AssetMeta } from '../db/schema'
import { ctx } from '../context'
import type { JobContext } from '../jobs/worker'
import { log } from '../log'
import { type AssetRow, assetPrefix, loadAsset, localSource, tmpDir, updateAsset } from '../services/assets'
import { ffmpeg, ffmpegProgress, runOk } from './proc'
import { describeStorageError } from '../services/storage-health'
import { isStorageError } from '../storage/errors'

export interface ProbeResult {
  kind: 'video' | 'audio' | 'image'
  duration?: number
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
  codec?: string
  formatName: string
  /** Absolute stream indexes of the picture and the sound probe chose (cover art is never the picture). */
  videoStream?: number
  audioStream?: number
  /** EXIF orientation of a photo (2–8; absent when upright). width/height are already the upright size. */
  orientation?: number
  /** HDR video (iPhone HLG, PQ): its 10-bit BT.2020 pictures must be tone-mapped before becoming 8-bit SDR. */
  hdr?: 'pq' | 'hlg'
}

interface FfStream {
  index: number
  codec_type: string
  codec_name?: string
  width?: number
  height?: number
  color_transfer?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  duration?: string
  nb_frames?: string
  tags?: Record<string, string>
  side_data_list?: Array<{ rotation?: number }>
  disposition?: { attached_pic?: number }
}

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'webp', 'bmp', 'tiff', 'gif', 'jpegls', 'svg'])

function rate(s?: string): number | undefined {
  if (!s) return undefined
  const [a, b] = s.split('/').map(Number)
  const v = b ? a / b : a
  return Number.isFinite(v) && v > 0 && v < 1000 ? Math.round(v * 1000) / 1000 : undefined
}

export async function probe(file: string, signal?: AbortSignal): Promise<ProbeResult> {
  const r = await runOk(ctx().config.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal }, 'ffprobe')
  const j = JSON.parse(r.stdout) as { streams?: FfStream[]; format?: { format_name?: string; duration?: string } }
  const streams = j.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const a = streams.find((s) => s.codec_type === 'audio')
  const formatName = j.format?.format_name ?? ''
  const dur = Number(j.format?.duration ?? v?.duration ?? a?.duration)
  const duration = Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) / 1000 : undefined
  let kind: ProbeResult['kind']
  if (v) {
    const still = IMAGE_CODECS.has(v.codec_name ?? '') && (!duration || Number(v.nb_frames ?? 1) <= 1 || /image2|_pipe/.test(formatName))
    kind = still ? 'image' : 'video'
  } else if (a) kind = 'audio'
  else throw new Error('No audio or video streams found in this file')
  let width = v?.width
  let height = v?.height
  const rot = Math.abs(Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0))
  if (rot === 90 || rot === 270) [width, height] = [height, width]
  // a phone photo is stored sideways with a tag saying how to turn it; browsers draw it upright, so its size is the
  // upright one (ffprobe reports the stored pixels)
  const orientation = kind === 'image' ? exifOrientation(file) : undefined
  if (orientation && orientation >= 5) [width, height] = [height, width]
  const hdr = v?.color_transfer === 'smpte2084' ? 'pq' : v?.color_transfer === 'arib-std-b67' ? 'hlg' : undefined
  return {
    kind,
    duration: kind === 'image' ? undefined : duration,
    width,
    height,
    fps: kind === 'video' ? rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate) : undefined,
    hasAudio: Boolean(a),
    codec: v?.codec_name ?? a?.codec_name,
    formatName,
    videoStream: v?.index,
    audioStream: a?.index,
    ...(orientation && orientation > 1 ? { orientation } : {}),
    ...(hdr ? { hdr } : {}),
  }
}

let toneMapping: Promise<boolean> | undefined

/** Whether this ffmpeg has the filters tone mapping needs (zscale is libzimg; Debian's and the static builds have it). */
function canToneMap(): Promise<boolean> {
  toneMapping ??= runOk(ctx().config.ffmpegPath, ['-hide_banner', '-filters'])
    .then((r) => {
      const ok = /\szscale\s/.test(r.stdout) && /\stonemap\s/.test(r.stdout)
      if (!ok) log.warn('ffmpeg has no zscale/tonemap filter: HDR clips will look washed out')
      return ok
    })
    .catch(() => false)
  return toneMapping
}

/**
 * Filters that turn an HDR picture (PQ or HLG, BT.2020) into SDR BT.709 before it becomes 8-bit: without them the
 * 10-bit values are read as SDR and iPhone footage comes out grey and washed out. Empty for SDR, or when this
 * ffmpeg can't. Put them after any scaling (cheaper on fewer pixels); they end in yuv420p.
 */
export async function sdrFilters(info: Pick<ProbeResult, 'hdr'>): Promise<string[]> {
  if (!info.hdr || !(await canToneMap())) return []
  const tin = info.hdr === 'pq' ? 'smpte2084' : 'arib-std-b67'
  return [`zscale=tin=${tin}:pin=bt2020:min=bt2020nc:t=linear:npl=100`, 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p']
}

/** `-vf` arguments for a single SDR still of `file` (a freeze frame): tone-mapped when the file is HDR. */
export async function sdrStillArgs(file: string, signal?: AbortSignal): Promise<string[]> {
  const info = await probe(file, signal).catch(() => undefined)
  const f = info ? await sdrFilters(info) : []
  return f.length ? ['-vf', f.join(',')] : []
}

/** The EXIF orientation (1–8) of a JPEG or TIFF, from its first 256 KB; undefined when it has none. */
export function exifOrientation(file: string): number | undefined {
  let buf: Buffer
  try {
    const fd = fs.openSync(file, 'r')
    try {
      buf = Buffer.alloc(256 * 1024)
      buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
  const fromTiff = (t: number): number | undefined => {
    if (t + 8 > buf.length) return undefined
    const le = buf.toString('latin1', t, t + 2) === 'II'
    if (!le && buf.toString('latin1', t, t + 2) !== 'MM') return undefined
    const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
    const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
    const ifd = t + u32(t + 4)
    if (ifd + 2 > buf.length) return undefined
    for (let i = 0, n = u16(ifd); i < n; i++) {
      const e = ifd + 2 + i * 12
      if (e + 12 > buf.length) return undefined
      if (u16(e) === 0x0112) {
        const o = u16(e + 8)
        return o >= 1 && o <= 8 ? o : undefined
      }
    }
    return undefined
  }
  // TIFF: the file is the IFD structure
  if (/^(II\*\0|MM\0\*)/.test(buf.toString('latin1', 0, 4))) return fromTiff(0)
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return undefined
  // JPEG: walk the segments to APP1 "Exif"
  for (let i = 2; i + 4 <= buf.length; ) {
    if (buf[i] !== 0xff) return undefined
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) return undefined
    const len = buf.readUInt16BE(i + 2)
    if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') return fromTiff(i + 10)
    i += 2 + len
  }
  return undefined
}

/** ffmpeg filters that turn a picture stored with EXIF `orientation` upright (use with -noautorotate). */
export function uprightFilters(orientation?: number): string[] {
  switch (orientation) {
    case 2:
      return ['hflip']
    case 3:
      return ['hflip', 'vflip']
    case 4:
      return ['vflip']
    case 5:
      return ['transpose=0']
    case 6:
      return ['transpose=1']
    case 7:
      return ['transpose=3']
    case 8:
      return ['transpose=2']
    default:
      return []
  }
}

/** Proxies play at no more than this: a 240 fps slow-motion clip makes a proxy no browser can decode smoothly. */
export const PROXY_MAX_FPS = 60

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('hex')
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/**
 * How long a file plays when its header doesn't say: browser and Loom recordings (MediaRecorder WebM) carry no
 * duration. A copy pass reads every packet without decoding any; the last timestamp (plus one frame) is the length.
 */
export async function measureDuration(file: string, info: Pick<ProbeResult, 'kind' | 'fps' | 'videoStream' | 'audioStream'>, signal?: AbortSignal): Promise<number | undefined> {
  const stream = info.kind === 'audio' ? info.audioStream : info.videoStream
  let last = 0
  let buf = ''
  await ffmpeg(['-progress', 'pipe:1', '-nostats', '-i', file, '-map', `0:${stream ?? (info.kind === 'audio' ? 'a:0' : 'v:0')}`, '-c', 'copy', '-f', 'null', '-'], {
    signal,
    onStdout: (s) => {
      buf += s
      for (const m of buf.matchAll(/out_time_us=(\d+)/g)) last = Math.max(last, Number(m[1]) / 1e6)
      buf = buf.slice(buf.lastIndexOf('\n') + 1)
    },
  })
  const d = last + (info.fps ? 1 / info.fps : 0)
  return d > 0 ? Math.round(d * 1000) / 1000 : undefined
}

/**
 * A filmstrip of `frames` tiles from as many quick seeks (each decodes from the keyframe before its time), instead of
 * decoding the whole file once more. `vf` scales each frame; `after` (tone mapping) runs once on the joined strip.
 */
async function quickFilmstrip(src: string, out: string, opts: { frames: number; duration: number; stream?: number; vf: string; after?: string; signal: AbortSignal }) {
  const { frames, duration } = opts
  const inputs: string[] = []
  const chains: string[] = []
  for (let i = 0; i < frames; i++) {
    inputs.push('-ss', String(Math.round(((i + 0.5) / frames) * duration * 1000) / 1000), '-i', src)
    chains.push(`[${i}:${opts.stream ?? 'v:0'}]${opts.vf},setsar=1[f${i}]`)
  }
  const graph = `${chains.join(';')};${Array.from({ length: frames }, (_, i) => `[f${i}]`).join('')}hstack=inputs=${frames}${opts.after ?? ''}[strip]`
  await ffmpeg([...inputs, '-filter_complex', graph, '-map', '[strip]', '-frames:v', '1', '-q:v', '5', out], { signal: opts.signal })
}

/** Target proxy size: short side ≤ 720, even dimensions. */
export function proxySize(w: number, h: number): { w: number; h: number } {
  const short = Math.min(w, h)
  const s = short > 720 ? 720 / short : 1
  return { w: even(w * s), h: even(h * s) }
}

/** Decode audio to mono 8 kHz s16le; returns ~50 peaks/s (0..1) and silence ranges. `onProgress` gets the seconds
 * decoded so far (a long recording takes a while). */
export async function analyseAudio(file: string, signal?: AbortSignal, onProgress?: (seconds: number) => void): Promise<{ waveform: number[]; silences: Array<{ start: number; end: number }> }> {
  const peaks: number[] = []
  const perPeak = 160 // 8000 Hz / 50
  let cur = 0
  let n = 0
  let carry: Buffer | null = null
  let reported = 0
  const r = await ffmpeg(['-i', file, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.4', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], {
    signal,
    onStdoutData: (b) => {
      if (onProgress && peaks.length - reported >= 250) {
        reported = peaks.length
        onProgress(peaks.length / 50)
      }
      let buf = carry ? Buffer.concat([carry, b]) : b
      const usable = buf.length - (buf.length % 2)
      carry = usable < buf.length ? buf.subarray(usable) : null
      buf = buf.subarray(0, usable)
      for (let i = 0; i < buf.length; i += 2) {
        const v = Math.abs(buf.readInt16LE(i))
        if (v > cur) cur = v
        if (++n >= perPeak) {
          peaks.push(Math.round((cur / 32768) * 1000) / 1000)
          cur = 0
          n = 0
        }
      }
    },
  })
  if (n > 0) peaks.push(Math.round((cur / 32768) * 1000) / 1000)
  const silences: Array<{ start: number; end: number }> = []
  let open: number | undefined
  for (const line of r.stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/)
    if (s) open = Math.max(0, Number(s[1]))
    const e = line.match(/silence_end:\s*([\d.]+)/)
    if (e && open !== undefined) {
      silences.push({ start: Math.round(open * 1000) / 1000, end: Math.round(Number(e[1]) * 1000) / 1000 })
      open = undefined
    }
  }
  if (open !== undefined) silences.push({ start: Math.round(open * 1000) / 1000, end: Math.round((peaks.length / 50) * 1000) / 1000 })
  return { waveform: peaks, silences }
}

/**
 * What a person sees on a clip that failed to process. Raw ffprobe output named a server file path and meant
 * nothing to anyone ("moov atom not found | C:\\...\\source.mov: Invalid data found"); storage errors read as SDK
 * internals. Keep the cause, drop the paths, say what to do.
 */
export function friendlyProcessingError(err: unknown): string {
  if (isStorageError(err)) return describeStorageError(err)
  const msg = err instanceof Error ? err.message : String(err)
  if (/moov atom not found/i.test(msg))
    return "This file is incomplete or damaged: its video index (the 'moov atom') is missing, which usually means the recording or upload was cut off. Export it again and upload the new file."
  if (/Invalid data found when processing input|could not find codec parameters|Unknown format/i.test(msg))
    return "This file isn't a video, audio or image format the server can read. Convert it to MP4 (or MP3, PNG, JPG) and upload it again."
  if (/ENOENT|no such file/i.test(msg)) return "The uploaded file couldn't be found in storage. Upload it again."
  if (/ENOSPC|No space left on device/i.test(msg)) return 'The server ran out of disk space while processing this clip. Retry in a while.'
  const clean = msg
    .replace(/[A-Za-z]:\\[^\s:|]+/g, '…')
    .replace(/(?:\/[\w.@-]+){2,}/g, '…')
    .replace(/\[[\w,]+ @ 0x?[0-9a-f]+\]\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `Processing failed: ${clean.slice(0, 300)}`
}

/** Process one asset (used by the asset.process job and inline after TTS/render). */
export async function processAsset(assetId: string, jc: Pick<JobContext, 'signal' | 'progress' | 'check'>): Promise<AssetRow> {
  let row = await loadAsset(assetId)
  const work = tmpDir(`proc-${assetId}`)
  const storage = ctx().storage
  const prefix = assetPrefix(row.workspaceId, row.id)
  try {
    jc.progress(0.02, 'Reading media')
    const src = await localSource(row, work)
    // Local storage checked the hash on `complete`; S3 uploads went straight to the bucket, so check here. A declared
    // hash that doesn't match means a truncated or altered upload — every desktop would refuse that clip forever.
    if (!row.sha256 || !storage.localPath) {
      const actual = await sha256File(src)
      if (row.sha256 && row.sha256 !== actual) throw new Error("The uploaded file doesn't match the one that was sent (its fingerprint differs): the upload was cut short or altered. Upload it again.")
      if (!row.sha256) row = await updateAsset(row.id, { sha256: actual })
    }
    const info = await probe(src, jc.signal)
    jc.check()
    // only what processing finds: updateAsset merges it into the clip's metadata (a transcript or voice text saved
    // while this runs stays)
    const meta: AssetMeta = { duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio, codec: info.codec }
    const keys: Partial<AssetRow> = {}
    const put = async (file: string, name: string, mime: string) => {
      const key = `${prefix}/${name}`
      await storage.putFile(key, file, mime)
      return key
    }
    if (info.kind === 'video') {
      // a recording whose header has no length (browser / Loom WebM): measure it, or nothing can size the clip
      if (!meta.duration) meta.duration = await measureDuration(src, info, jc.signal)
      const dur = meta.duration ?? 0
      const W = info.width ?? 1280
      const H = info.height ?? 720
      // iPhone HDR is tone-mapped wherever it becomes an 8-bit picture: thumbnail, filmstrip, proxy
      const sdr = (await sdrFilters(info)).map((f) => `,${f}`).join('')
      // the picture probe chose, never cover art (ffmpeg's own pick is the largest picture, often the cover)
      const vmap = ['-map', `0:${info.videoStream ?? 'v:0'}`]
      const amap = ['-map', `0:${info.audioStream ?? 'a:0'}`]
      // the thumbnail first, saved on the clip at once, so the library shows something while the rest runs
      jc.progress(0.05, 'Thumbnail')
      const thumb = path.join(work, 'thumb.jpg')
      await ffmpeg(['-ss', String(Math.min(1, dur * 0.1)), '-i', src, ...vmap, '-frames:v', '1', '-vf', `scale=-2:360${sdr}`, '-q:v', '4', thumb], { signal: jc.signal })
      keys.thumbKey = await put(thumb, 'thumb.jpg', 'image/jpeg')
      row = await updateAsset(row.id, { thumbKey: keys.thumbKey, meta, kind: 'video' })
      jc.check()
      jc.progress(0.08, 'Filmstrip')
      const frames = 10
      const fh = 160
      const fw = even((W / H) * fh)
      const strip = path.join(work, 'filmstrip.jpg')
      await quickFilmstrip(src, strip, { frames, duration: dur, stream: info.videoStream, vf: `scale=${fw}:${fh}`, after: sdr, signal: jc.signal }).catch((err) => {
        if (jc.signal.aborted) throw err
        log.warn('quick filmstrip failed; decoding the whole clip', { assetId, err })
      })
      if (!fs.existsSync(strip)) {
        const fpsExpr = dur > 0 ? `${frames}/${Math.max(0.5, dur).toFixed(3)}` : '1'
        await ffmpeg(['-i', src, ...vmap, '-vf', `fps=${fpsExpr},scale=${fw}:${fh}${sdr},tile=${frames}x1`, '-frames:v', '1', '-q:v', '5', strip], { signal: jc.signal })
      }
      keys.filmstripKey = await put(strip, 'filmstrip.jpg', 'image/jpeg')
      meta.filmstrip = { frames, frameWidth: fw, frameHeight: fh }
      row = await updateAsset(row.id, { filmstripKey: keys.filmstripKey, meta: { filmstrip: meta.filmstrip } })
      jc.check()
      if (info.hasAudio) {
        // two passes over the sound: report how far each has got (an hour-long recording takes minutes)
        jc.progress(0.1, 'Waveform')
        const a = await analyseAudio(src, jc.signal, (s) => dur > 0 && jc.progress(0.1 + Math.min(1, s / dur) * 0.08, 'Waveform'))
        meta.waveform = a.waveform
        meta.silences = a.silences
        jc.progress(0.18, 'Extracting audio')
        const m4a = path.join(work, 'audio.m4a')
        await ffmpegProgress(['-i', src, ...amap, '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', m4a], dur, (f) => jc.progress(0.18 + f * 0.06, 'Extracting audio'), { signal: jc.signal })
        keys.audioKey = await put(m4a, 'audio.m4a', 'audio/mp4')
        jc.check()
      }
      // publish what we have so far, then build the proxy
      row = await updateAsset(row.id, { ...keys, meta, kind: 'video' })
      jc.progress(0.25, 'Building edit proxy')
      const { w, h } = proxySize(W, H)
      const proxy = path.join(work, 'proxy.mp4')
      // slow-motion footage (120/240 fps) is shown at 60: the clip's own rate stays in its metadata for the export
      const fast = (info.fps ?? 30) > PROXY_MAX_FPS
      const gop = String(Math.max(1, Math.round(Math.min(info.fps ?? 30, PROXY_MAX_FPS))))
      await ffmpegProgress(
        [
          '-i', src,
          ...vmap, ...(info.hasAudio ? amap : []),
          '-vf', `${fast ? `fps=${PROXY_MAX_FPS},` : ''}scale=${w}:${h}${sdr},format=yuv420p`,
          ...(sdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', gop, '-keyint_min', gop,
          ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
          '-movflags', '+faststart',
          proxy,
        ],
        dur,
        (f) => jc.progress(0.25 + f * 0.72, 'Building edit proxy'),
        { signal: jc.signal },
      )
      keys.proxyKey = await put(proxy, 'proxy.mp4', 'video/mp4')
      // the proxy's own header always has a length
      if (!meta.duration) meta.duration = (await probe(proxy, jc.signal).catch(() => undefined))?.duration
    } else if (info.kind === 'audio') {
      jc.progress(0.2, 'Waveform')
      const a = await analyseAudio(src, jc.signal, (s) => meta.duration && jc.progress(0.2 + Math.min(1, s / meta.duration) * 0.75, 'Waveform'))
      meta.waveform = a.waveform
      meta.silences = a.silences
      if (!meta.duration) meta.duration = Math.round((a.waveform.length / 50) * 1000) / 1000
    } else {
      jc.progress(0.3, 'Thumbnail')
      const thumb = path.join(work, 'thumb.jpg')
      // turned upright here whatever this ffmpeg does with the tag (6.1 turns JPEGs itself, 5.1 doesn't)
      const vf = [...uprightFilters(info.orientation), "scale='min(640,iw)':-2"].join(',')
      await ffmpeg(['-noautorotate', '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '4', thumb], { signal: jc.signal })
      keys.thumbKey = await put(thumb, 'thumb.jpg', 'image/jpeg')
    }
    jc.check()
    row = await updateAsset(row.id, { ...keys, meta, kind: info.kind, status: 'ready', error: null })
    jc.progress(1, 'Ready')
    return row
  } catch (err) {
    const cancelled = jc.signal.aborted
    if (!cancelled) log.warn('asset processing failed', { assetId, err })
    await updateAsset(assetId, { status: 'error', error: cancelled ? 'Processing was cancelled. Retry to process it again.' : friendlyProcessingError(err).slice(0, 500) }).catch(() => undefined)
    throw err
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}
