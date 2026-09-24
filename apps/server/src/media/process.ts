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

export interface ProbeResult {
  kind: 'video' | 'audio' | 'image'
  duration?: number
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
  codec?: string
  formatName: string
}

interface FfStream {
  codec_type: string
  codec_name?: string
  width?: number
  height?: number
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
  return {
    kind,
    duration: kind === 'image' ? undefined : duration,
    width,
    height,
    fps: kind === 'video' ? rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate) : undefined,
    hasAudio: Boolean(a),
    codec: v?.codec_name ?? a?.codec_name,
    formatName,
  }
}

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('hex')
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** Target proxy size: short side ≤ 720, even dimensions. */
export function proxySize(w: number, h: number): { w: number; h: number } {
  const short = Math.min(w, h)
  const s = short > 720 ? 720 / short : 1
  return { w: even(w * s), h: even(h * s) }
}

/** Decode audio to mono 8 kHz s16le; returns ~50 peaks/s (0..1) and silence ranges. */
export async function analyseAudio(file: string, signal?: AbortSignal): Promise<{ waveform: number[]; silences: Array<{ start: number; end: number }> }> {
  const peaks: number[] = []
  const perPeak = 160 // 8000 Hz / 50
  let cur = 0
  let n = 0
  let carry: Buffer | null = null
  const r = await ffmpeg(['-i', file, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.4', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], {
    signal,
    onStdoutData: (b) => {
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

/** Process one asset (used by the asset.process job and inline after TTS/render). */
export async function processAsset(assetId: string, jc: Pick<JobContext, 'signal' | 'progress' | 'check'>): Promise<AssetRow> {
  let row = await loadAsset(assetId)
  const work = tmpDir(`proc-${assetId}`)
  const storage = ctx().storage
  const prefix = assetPrefix(row.workspaceId, row.id)
  try {
    jc.progress(0.02, 'Reading media')
    const src = await localSource(row, work)
    if (!row.sha256) row = await updateAsset(row.id, { sha256: await sha256File(src) })
    const info = await probe(src, jc.signal)
    jc.check()
    const meta: AssetMeta = { ...(row.meta ?? {}), duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio, codec: info.codec }
    const keys: Partial<AssetRow> = {}
    const put = async (file: string, name: string, mime: string) => {
      const key = `${prefix}/${name}`
      await storage.putFile(key, file, mime)
      return key
    }
    if (info.kind === 'video') {
      const dur = info.duration ?? 0
      const W = info.width ?? 1280
      const H = info.height ?? 720
      // thumbnail + filmstrip first so the library shows something quickly
      jc.progress(0.05, 'Thumbnail')
      const thumb = path.join(work, 'thumb.jpg')
      await ffmpeg(['-ss', String(Math.min(1, dur * 0.1)), '-i', src, '-frames:v', '1', '-vf', 'scale=-2:360', '-q:v', '4', thumb], { signal: jc.signal })
      keys.thumbKey = await put(thumb, 'thumb.jpg', 'image/jpeg')
      jc.check()
      jc.progress(0.1, 'Filmstrip')
      const frames = 10
      const fh = 160
      const fw = even((W / H) * fh)
      const strip = path.join(work, 'filmstrip.jpg')
      const fpsExpr = dur > 0 ? `${frames}/${Math.max(0.5, dur).toFixed(3)}` : '1'
      await ffmpeg(['-i', src, '-vf', `fps=${fpsExpr},scale=${fw}:${fh},tile=${frames}x1`, '-frames:v', '1', '-q:v', '5', strip], { signal: jc.signal })
      keys.filmstripKey = await put(strip, 'filmstrip.jpg', 'image/jpeg')
      meta.filmstrip = { frames, frameWidth: fw, frameHeight: fh }
      jc.check()
      if (info.hasAudio) {
        jc.progress(0.15, 'Waveform')
        const a = await analyseAudio(src, jc.signal)
        meta.waveform = a.waveform
        meta.silences = a.silences
        const m4a = path.join(work, 'audio.m4a')
        await ffmpeg(['-i', src, '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', m4a], { signal: jc.signal })
        keys.audioKey = await put(m4a, 'audio.m4a', 'audio/mp4')
        jc.check()
      }
      // publish what we have so far, then build the proxy
      row = await updateAsset(row.id, { ...keys, meta, kind: 'video' })
      jc.progress(0.25, 'Building edit proxy')
      const { w, h } = proxySize(W, H)
      const proxy = path.join(work, 'proxy.mp4')
      const gop = String(Math.max(1, Math.round(info.fps ?? 30)))
      await ffmpegProgress(
        [
          '-i', src,
          '-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0?'] : []),
          '-vf', `scale=${w}:${h},format=yuv420p`,
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
    } else if (info.kind === 'audio') {
      jc.progress(0.2, 'Waveform')
      const a = await analyseAudio(src, jc.signal)
      meta.waveform = a.waveform
      meta.silences = a.silences
      if (!meta.duration) meta.duration = Math.round((a.waveform.length / 50) * 1000) / 1000
    } else {
      jc.progress(0.3, 'Thumbnail')
      const thumb = path.join(work, 'thumb.jpg')
      await ffmpeg(['-i', src, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '4', thumb], { signal: jc.signal })
      keys.thumbKey = await put(thumb, 'thumb.jpg', 'image/jpeg')
    }
    jc.check()
    row = await updateAsset(row.id, { ...keys, meta, kind: info.kind, status: 'ready', error: null })
    jc.progress(1, 'Ready')
    return row
  } catch (err) {
    const cancelled = jc.signal.aborted
    if (!cancelled) log.warn('asset processing failed', { assetId, err })
    await updateAsset(assetId, { status: 'error', error: cancelled ? 'Processing cancelled' : err instanceof Error ? err.message.slice(0, 500) : String(err) }).catch(() => undefined)
    throw err
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}
