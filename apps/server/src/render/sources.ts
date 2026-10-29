// The video files an export renders from (P-18 and the colour fix carried from release 3).
//
// - Colour: HyperFrames draws video from JPEG frames, which are read as BT.601 whatever the file says. A source in
//   another matrix (BT.709: nearly all HD camera footage, and HD files with no tag) is converted to BT.601 values
//   first, so the export shows the colours the editor shows (media/colour.ts).
// - Length: a long source of which the edit uses a little is cut to the windows it uses (stream copy from a keyframe,
//   or within the conversion), so the render folder holds minutes, not hours; on S3 ffmpeg reads just those windows
//   from the bucket instead of the whole file being downloaded first.
// Each window becomes a file of its own; the clips using it are pointed at it with their in-points moved by where it
// starts in the source, so the composition (and the runtime inside it) play exactly the frames they did.
import fs from 'node:fs'
import path from 'node:path'
import { clipSourceAt, exportWindow, smoothSource, type Project } from '@producer/core'
import { isBt601, toBt601Filters, colourTagArgs, videoMatrix } from '../media/colour'
import { encodeH264, h264Args } from '../media/hwenc'
import { ffmpeg, runOk } from '../media/proc'
import { probe, type ProbeResult } from '../media/process'
import { ctx } from '../context'
import { log } from '../log'

export interface Window {
  from: number
  to: number
}

/** Seconds kept either side of what a clip shows (decoder pre-roll, rounding, a sound's fade). */
const PAD = 1.5
/** Windows closer than this are one window. */
const JOIN_GAP = 5
/** A source is cut only when the edit uses less than this share of it and it is at least this long. */
const TRIM_SHARE = 0.6
const TRIM_MIN_SECONDS = 60

/**
 * The source windows the edit uses of each video asset, joined where they touch, with the clips' transition handles
 * and some padding. Assets the planner must leave whole (a clip plays a smooth copy of it) are left out.
 */
export function usedWindows(p: Project): Map<string, Window[]> {
  const raw = new Map<string, Window[]>()
  const whole = new Set<string>()
  const add = (id: string, from: number, to: number) => {
    const list = raw.get(id) ?? []
    list.push({ from: Math.max(0, Math.min(from, to) - PAD), to: Math.max(from, to) + PAD })
    raw.set(id, list)
  }
  for (let ti = 0; ti < p.tracks.length; ti++)
    for (let ii = 0; ii < p.tracks[ti].items.length; ii++) {
      const it = p.tracks[ti].items[ii]
      if (it.type === 'video') {
        // a smooth copy's timing, or a reversed copy's padding, is worked out from the whole source
        if (it.smooth?.assetId || smoothSource(p, it) || it.reverse) whole.add(it.assetId)
        const w = exportWindow(p, ti, ii)
        add(it.assetId, clipSourceAt(it, w.start - it.start), clipSourceAt(it, w.end - it.start))
      } else if (it.type === 'audio') {
        // a sound on its own track widens into the fades either side
        add(it.assetId, clipSourceAt(it, -3), clipSourceAt(it, it.duration + 3))
      }
    }
  const out = new Map<string, Window[]>()
  for (const [id, list] of raw) {
    if (whole.has(id)) continue
    list.sort((a, b) => a.from - b.from)
    const merged: Window[] = []
    for (const w of list) {
      const last = merged[merged.length - 1]
      if (last && w.from <= last.to + JOIN_GAP) last.to = Math.max(last.to, w.to)
      else merged.push({ ...w })
    }
    out.set(id, merged)
  }
  return out
}

/** Whether to cut `windows` out of a source `duration` long rather than use it whole. */
export function worthTrimming(windows: Window[], duration: number | undefined): boolean {
  if (!SOURCE_PREP.trim || !duration || duration < TRIM_MIN_SECONDS || !windows.length) return false
  const used = windows.reduce((s, w) => s + Math.min(w.to, duration) - w.from, 0)
  return used < duration * TRIM_SHARE
}

/** Tests switch the colour conversion or the cutting off, to see (and measure) the export as it was. */
export const SOURCE_PREP = { colour: true, trim: true }

/** Whether the export must convert this video's colours from `matrix` (see the top of this file). HDR is HyperFrames' to tone-map. */
export function needsColourConversion(info: Pick<ProbeResult, 'kind' | 'hdr' | 'alpha'>, matrix: string): boolean {
  return SOURCE_PREP.colour && info.kind === 'video' && !info.hdr && !info.alpha && !isBt601(matrix)
}

/**
 * The matrix the editor showed a file in. A source: what processing found (meta.colorMatrix) or works out now. An
 * edit proxy: its tag; one made before proxies were tagged was shown by the browser's rule for untagged video.
 */
export function shownMatrix(info: Pick<ProbeResult, 'colorSpace' | 'encoder' | 'width' | 'height'>, o: { proxy: boolean; recorded?: string }): string {
  if (o.proxy) return info.colorSpace ? videoMatrix(info).matrix : videoMatrix({ width: info.width, height: info.height }).matrix
  return o.recorded ?? videoMatrix(info).matrix
}

/** The keyframe at or before `t` (a stream copy can only start on one), or 0. */
async function keyframeBefore(src: string, t: number, signal?: AbortSignal): Promise<number> {
  if (t <= 0) return 0
  const r = await runOk(ctx().config.ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-read_intervals', `${Math.max(0, t - 20)}%${t + 0.001}`, '-show_entries', 'frame=pts_time,best_effort_timestamp_time', '-of', 'csv=p=0', src], { signal }, 'ffprobe')
  let best = 0
  for (const line of r.stdout.split(/\r?\n/)) {
    const v = Number(line.split(',').find((x) => x && x !== 'N/A'))
    if (Number.isFinite(v) && v <= t + 1e-6 && v > best) best = v
  }
  return best
}

/** Where the first picture of a cut file sits in it (a copy can start its sound a little before the picture). */
async function videoStartIn(file: string, signal?: AbortSignal): Promise<number> {
  const r = await runOk(ctx().config.ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', file], { signal }, 'ffprobe')
  const v = Number(r.stdout.trim().split(/\r?\n/)[0])
  return Number.isFinite(v) ? v : 0
}

export interface PreparedSource {
  /** File name in the render folder's assets/ folder. */
  name: string
  /** Source seconds at the file's time 0. */
  offset: number
  /** The source window it holds (the whole file: from 0 to its length). */
  window: Window
}

/**
 * Make the export's files for one video source: converted to BT.601 when its colours need it, cut to `windows` when
 * that is worth it (else one file of the whole). Undefined: use the source as it is.
 */
export async function prepareVideoSource(
  src: string,
  assetId: string,
  windows: Window[] | undefined,
  dir: string,
  opts: { info: ProbeResult; matrix: string; ext: string; quality: 'draft' | 'standard' | 'high'; signal?: AbortSignal },
): Promise<PreparedSource[] | undefined> {
  const { info, matrix } = opts
  const convert = needsColourConversion(info, matrix)
  const trim = !!windows && worthTrimming(windows, info.duration)
  if (!convert && !trim) return undefined
  const list = trim ? windows! : [{ from: 0, to: info.duration ?? 0 }]
  const out: PreparedSource[] = []
  for (let k = 0; k < list.length; k++) {
    const w = list[k]
    // a converted file is H.264 in MP4; a cut one keeps its codec, so its container
    // never the whole file's own name: it may be in assets/ already (linked there to be read)
    const name = `${assetId}~${k + 1}${convert ? '.mp4' : opts.ext}`
    const file = path.join(dir, 'assets', name)
    const start = trim ? await keyframeBefore(src, w.from, opts.signal) : 0
    const len = trim ? Math.max(0.1, w.to - start) : undefined
    const range = [...(start > 0 ? ['-ss', String(start)] : []), '-i', src, ...(len ? ['-t', String(Math.round(len * 1000) / 1000)] : [])]
    const vmap = ['-map', `0:${info.videoStream ?? 'v:0'}`, ...(info.hasAudio ? ['-map', `0:${info.audioStream ?? 'a:0'}?`] : [])]
    if (convert) {
      // the same picture in BT.601 values, at the export's quality (a draft reads the proxy: small and quick)
      const crf = opts.quality === 'high' ? 10 : opts.quality === 'standard' ? 14 : 20
      await encodeH264(
        (enc) => [...range, ...vmap, '-vf', toBt601Filters(matrix, info.colorRange).join(','), ...colourTagArgs('smpte170m'), ...h264Args(enc, { crf, gop: 30 }), ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '320k'] : ['-an']), '-movflags', '+faststart', file],
        (args) => ffmpeg(args, { signal: opts.signal }),
        opts.signal,
      )
    } else {
      await ffmpeg([...range, ...vmap, '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', file], { signal: opts.signal })
    }
    // file time t is source time t + offset (a copy's sound may start just before the keyframe it was cut at)
    const offset = start - (start > 0 ? await videoStartIn(file, opts.signal) : 0)
    out.push({ name, offset, window: trim ? w : { from: 0, to: info.duration ?? 0 } })
  }
  if (trim) log.info('export: cut a long source to the parts used', { assetId, windows: list.length, seconds: Math.round(list.reduce((s, w) => s + w.to - w.from, 0)), of: Math.round(info.duration ?? 0) })
  return out
}

/**
 * The project pointed at the prepared files: each video and audio clip of a prepared asset plays the window holding
 * it (a new asset id when there are several), its in-point moved by where that window starts.
 */
export function pointAtPrepared(p: Project, prepared: Map<string, PreparedSource[]>): Project {
  if (!prepared.size) return p
  const assets = { ...p.assets }
  const idFor = (assetId: string, k: number, list: PreparedSource[]) => (list.length > 1 ? `${assetId}~${k + 1}` : assetId)
  for (const [id, list] of prepared)
    list.forEach((s, k) => {
      const a = p.assets[id]
      if (a) assets[idFor(id, k, list)] = { ...a, id: idFor(id, k, list), ...(a.duration !== undefined ? { duration: s.window.to - s.offset } : {}) }
    })
  const tracks = p.tracks.map((t) => ({
    ...t,
    items: t.items.map((it) => {
      if ((it.type !== 'video' && it.type !== 'audio') || !prepared.has(it.assetId) || (it.type === 'video' && it.freezeAt !== undefined)) return it
      const list = prepared.get(it.assetId)!
      const at = it.in
      const k = Math.max(0, list.findIndex((s) => at >= s.window.from - 1e-6 && at <= s.window.to + 1e-6))
      return { ...it, assetId: idFor(it.assetId, k, list), in: Math.max(0, it.in - list[k].offset) }
    }),
  })) as Project['tracks']
  return { ...p, assets, tracks }
}

/** Probe a source the export will prepare (a local path or a signed URL). */
export async function probeSource(src: string, signal?: AbortSignal): Promise<ProbeResult | undefined> {
  return probe(src, signal).catch((err) => {
    log.warn('export: could not read a source to prepare it; using it as it is', { err })
    return undefined
  })
}

export const preparedFileExists = (dir: string, s: PreparedSource) => fs.existsSync(path.join(dir, 'assets', s.name))
