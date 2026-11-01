// Startup health check of the tools the desktop engine bundles (D-13): ffmpeg and ffprobe actually run, whisper and its
// model are there, the Kokoro voice model is there, and the renderer (HyperFrames + its Chrome) can start. A broken
// install explains itself (Settings and a dialog at start) instead of failing later on the first export or
// transcription. Filesystem and process access go through a seam so every outcome can be tested.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { ToolCheck, ToolHealth } from '@producer/core'
import { childEnv } from '../child-env'
import type { Config } from '../config'

const require = createRequire(import.meta.url)

export interface ToolDeps {
  exists(p: string): boolean
  /** Size in bytes, or -1. */
  size(p: string): number
  /** Run `bin args` (RUN_LIMIT_MS at most): exit code and output, or the start error (`'timeout'` when it ran out). */
  run(bin: string, args: string[]): Promise<{ code: number; out: string; error?: string }>
  resolvable(mod: string): boolean
  readdir(dir: string): string[]
}

export const realToolDeps = (): ToolDeps => ({
  exists: (p) => fs.existsSync(p),
  size: (p) => {
    try {
      return fs.statSync(p).size
    } catch {
      return -1
    }
  },
  run: (bin, args) =>
    new Promise((resolve) => {
      execFile(bin, args, { windowsHide: true, timeout: RUN_LIMIT_MS, env: childEnv(), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean }) | null
        if (e?.killed) return resolve({ code: -1, out: '', error: 'timeout' })
        if (e && typeof e.code === 'string') return resolve({ code: -1, out: '', error: e.code === 'ENOENT' ? 'not found' : e.message })
        resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: `${stdout ?? ''}\n${stderr ?? ''}` })
      })
    }),
  resolvable: (mod) => {
    try {
      require.resolve(mod)
      return true
    } catch {
      return false
    }
  },
  readdir: (dir) => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  },
})

/**
 * How long `-version` may take. Warm, ffmpeg answers in a fraction of a second; the first run of a freshly installed copy
 * took 7.4 s on its own here (Windows scans an 82 MB unsigned binary before it runs), and longer at start-up with the
 * engine and ffprobe starting beside it, which a 10 s limit turned into a "reinstall" dialog on a good install.
 */
export const RUN_LIMIT_MS = 60_000

type ToolConfig = Pick<Config, 'ffmpegPath' | 'ffprobePath' | 'whisperCli' | 'whisperModel' | 'kokoroCache' | 'chromePath'>

const REINSTALL = 'Reinstall Producer Studio to put it back.'

async function runs(id: 'ffmpeg' | 'ffprobe', bin: string, d: ToolDeps): Promise<ToolCheck> {
  const base = { id, name: id === 'ffmpeg' ? 'ffmpeg' : 'ffprobe', needed: id === 'ffmpeg' ? 'Uploads, proxies, clean-up tools and exports' : 'Reading what is in a clip (length, size, tracks)', path: bin }
  // a bare name is looked up on PATH; a path must exist
  if (path.isAbsolute(bin) && !d.exists(bin)) return { ...base, status: 'error', detail: `Not found at ${bin}. ${REINSTALL}` }
  const r = await d.run(bin, ['-version'])
  // slow is not broken: say so in Settings (a warning), not in the start-up dialog that says to reinstall
  if (r.error === 'timeout') return { ...base, status: 'warn', detail: `Didn’t answer within ${RUN_LIMIT_MS / 1000} s. The first start after installing can be slow while Windows checks the new files; Settings → This computer can check again.` }
  if (r.error) return { ...base, status: 'error', detail: r.error === 'not found' ? `Not found (${bin}). ${REINSTALL}` : `Couldn’t start: ${r.error}. ${REINSTALL}` }
  const version = r.out.match(/(?:ffmpeg|ffprobe) version (\S+)/)?.[1]
  if (r.code !== 0 || !version) return { ...base, status: 'error', detail: `Started but didn’t answer as ${base.name} does (exit code ${r.code}). ${REINSTALL}` }
  return { ...base, status: 'ok', detail: `${base.name} ${version}` }
}

function whisper(cfg: ToolConfig, d: ToolDeps): ToolCheck {
  const base = { id: 'whisper' as const, name: 'Transcription (whisper)', needed: 'Captions, transcripts and Producer scripts from speech', path: cfg.whisperCli }
  if (!cfg.whisperCli) return { ...base, status: 'error', detail: `The whisper program isn’t installed. ${REINSTALL}` }
  if (!d.exists(cfg.whisperCli)) return { ...base, status: 'error', detail: `The whisper program is missing (${cfg.whisperCli}). ${REINSTALL}` }
  if (!cfg.whisperModel || !d.exists(cfg.whisperModel)) return { ...base, status: 'error', detail: `The speech model is missing${cfg.whisperModel ? ` (${cfg.whisperModel})` : ''}. ${REINSTALL}` }
  // ggml models are tens of MB at least: a stub or a cut-off download can't transcribe
  if (d.size(cfg.whisperModel) < 1024 * 1024) return { ...base, status: 'error', detail: `The speech model is damaged or incomplete (${cfg.whisperModel}). ${REINSTALL}` }
  return { ...base, status: 'ok', detail: `Model ${path.basename(cfg.whisperModel)}` }
}

function kokoro(cfg: ToolConfig, d: ToolDeps): ToolCheck {
  const base = { id: 'kokoro' as const, name: 'Voices (Kokoro)', needed: 'Built-in voiceovers', path: cfg.kokoroCache }
  if (!d.resolvable('kokoro-js')) return { ...base, status: 'error', detail: `The voice engine is missing. ${REINSTALL}` }
  const dir = cfg.kokoroCache ? path.join(cfg.kokoroCache, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx') : ''
  const model = dir && d.readdir(dir).find((f) => f.endsWith('.onnx'))
  if (!model) return { ...base, status: 'warn', detail: 'The voice model isn’t on this computer yet: it downloads (about 90 MB) the first time you make a voiceover, which needs the internet.' }
  return { ...base, status: 'ok', detail: `Model ${model}` }
}

function renderer(cfg: ToolConfig, d: ToolDeps): ToolCheck {
  const base = { id: 'renderer' as const, name: 'Renderer (HyperFrames)', needed: 'Exports', path: cfg.chromePath }
  if (!d.resolvable('hyperframes/package.json')) return { ...base, status: 'error', detail: `The renderer is missing. ${REINSTALL}` }
  if (process.env.RUNTIME_JS && !d.exists(process.env.RUNTIME_JS)) return { ...base, status: 'error', detail: `The renderer’s runtime is missing (${process.env.RUNTIME_JS}). ${REINSTALL}` }
  if (!cfg.chromePath) return { ...base, status: 'warn', detail: 'Its browser isn’t on this computer yet: the first export downloads it, which needs the internet.' }
  if (!d.exists(cfg.chromePath)) return { ...base, status: 'error', detail: `Its browser is missing (${cfg.chromePath}). ${REINSTALL}` }
  return { ...base, status: 'ok', detail: `Browser ${path.basename(path.dirname(cfg.chromePath)) || 'found'}` }
}

/** Check every tool (ffmpeg and ffprobe are run; the rest are looked for). */
export async function checkTools(cfg: ToolConfig, d: ToolDeps = realToolDeps(), now = Date.now()): Promise<ToolHealth> {
  const [ffmpeg, ffprobe] = await Promise.all([runs('ffmpeg', cfg.ffmpegPath, d), runs('ffprobe', cfg.ffprobePath, d)])
  const tools = [ffmpeg, ffprobe, whisper(cfg, d), kokoro(cfg, d), renderer(cfg, d)]
  return { checkedAt: now, ok: tools.every((t) => t.status !== 'error'), tools }
}

const TTL_MS = 5 * 60_000
let cached: { at: number; health: Promise<ToolHealth> } | undefined

/** The last check (at most 5 minutes old), or a new one; `refresh` checks again now. */
export function toolHealth(cfg: ToolConfig, refresh = false): Promise<ToolHealth> {
  if (!refresh && cached && Date.now() - cached.at < TTL_MS) return cached.health
  const health = checkTools(cfg)
  cached = { at: Date.now(), health }
  health.catch(() => (cached = undefined))
  return health
}
