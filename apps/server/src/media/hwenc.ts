// Hardware H.264 encoding where this machine's ffmpeg has a working one (P-18): NVIDIA (nvenc), Intel (Quick Sync),
// AMD (AMF), Apple (VideoToolbox). Probed once on first use by encoding a few frames, since a build lists encoders
// whether or not the hardware is there. HW_ENCODE=off keeps everything on libx264; HW_ENCODE=<name> picks one.
// An encode that fails on the hardware is made again in software, and that encoder isn't used again by this process.
import { ctx } from '../context'
import { log } from '../log'
import { run } from './proc'

export type HwEncoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_videotoolbox'

const CANDIDATES: HwEncoder[] = process.platform === 'darwin' ? ['h264_videotoolbox'] : ['h264_nvenc', 'h264_qsv', 'h264_amf']

let probing: Promise<HwEncoder | null> | undefined
let broken = false

/** Whether `name` encodes here: listed by this ffmpeg, and a few frames of it come out. */
async function works(name: string): Promise<boolean> {
  const r = await run(ctx().config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30', '-frames:v', '5', '-pix_fmt', 'yuv420p', '-c:v', name, '-f', 'null', '-'], { timeoutMs: 20_000 }).catch(() => null)
  return r?.code === 0
}

/** The hardware encoder to use, or null for software. */
export function hardwareEncoder(): Promise<HwEncoder | null> {
  if (broken) return Promise.resolve(null)
  probing ??= (async () => {
    const want = (ctx().config.hwEncode ?? 'auto').trim().toLowerCase()
    if (want === 'off' || want === '0' || want === 'false' || want === 'software') return null
    const list = await run(ctx().config.ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 20_000 }).catch(() => null)
    const listed = (n: string) => new RegExp(`\\s${n}\\s`).test(list?.stdout ?? '')
    const order = want === 'auto' || want === 'on' ? CANDIDATES : (CANDIDATES as string[]).includes(want) ? [want as HwEncoder] : []
    for (const name of order) if (listed(name) && (await works(name))) {
      log.info('hardware video encoding', { encoder: name })
      return name
    }
    if (want !== 'auto') log.warn('HW_ENCODE asked for hardware encoding but none works here: using software', { want })
    return null
  })()
  return probing
}

/** Forget the probe, or (tests) say what it found. */
export function resetHardwareEncoder(found?: HwEncoder | null) {
  probing = found === undefined ? undefined : Promise.resolve(found)
  broken = false
}

/**
 * Output options for an H.264 encode at libx264's `crf` quality and `gop` frames between keyframes, on `enc` (null:
 * libx264 at `preset`). The hardware ones aim at about the same quality.
 */
export function h264Args(enc: HwEncoder | null, o: { crf: number; gop: number; preset?: string }): string[] {
  const g = ['-g', String(o.gop), '-keyint_min', String(o.gop)]
  switch (enc) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(o.crf + 2), '-b:v', '0', '-bf', '0', ...g]
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', String(o.crf), '-look_ahead', '0', ...g]
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', String(o.crf), '-qp_p', String(o.crf + 2), ...g]
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-q:v', String(Math.max(1, Math.min(100, 100 - o.crf * 2))), ...g]
    default:
      return ['-c:v', 'libx264', '-preset', o.preset ?? 'veryfast', '-crf', String(o.crf), ...g]
  }
}

/**
 * Run an encode on the hardware encoder when there is one, and again in software if that fails (a driver that
 * refuses this size or pixel format, a busy GPU). `build` makes the whole ffmpeg argument list for an encoder.
 */
export async function encodeH264(build: (enc: HwEncoder | null) => string[], go: (args: string[]) => Promise<unknown>, signal?: AbortSignal): Promise<HwEncoder | null> {
  const enc = await hardwareEncoder()
  if (enc) {
    try {
      await go(build(enc))
      return enc
    } catch (err) {
      if (signal?.aborted) throw err
      broken = true
      log.warn('hardware encode failed: encoding in software from now on', { encoder: enc, err })
    }
  }
  await go(build(null))
  return null
}
