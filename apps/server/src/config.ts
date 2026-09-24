// Runtime configuration from environment variables (documented in the root .env.example).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** apps/server in the repo; the packaged desktop app sets PS_SERVER_ROOT to its bundled server folder. */
export const SERVER_ROOT = process.env.PS_SERVER_ROOT ? path.resolve(process.env.PS_SERVER_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..')

const PRODUCER_APP = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Producer', 'resources', 'app', 'resources')

function firstExisting(paths: string[]): string | undefined {
  for (const p of paths) if (p && fs.existsSync(p)) return p
  return undefined
}

export type Role = 'all' | 'api' | 'worker'

export type Mode = 'cloud' | 'desktop'

export interface Config {
  /** cloud = hosted multi-user; desktop = bundled in the Electron app for one local user. */
  mode: Mode
  aiProvider: 'anthropic-api' | 'claude-cli' | 'none'
  version: string
  port: number
  role: Role
  production: boolean
  dataDir: string
  databaseUrl?: string
  /** PGlite data dir (dev). 'memory://' for tests. */
  pgliteDir: string
  publicUrl?: string
  maxUploadBytes: number
  workerConcurrency: number
  s3?: { bucket: string; endpoint?: string; region: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle: boolean }
  ffmpegPath: string
  ffprobePath: string
  whisperCli?: string
  whisperModel?: string
  whisperThreads: number
  kokoroCache?: string
  producerSkillDir: string
  webDist: string
  chromePath?: string
  hyperframesProtocolTimeout?: string
}

let ffmpegStatic: string | undefined
let ffprobeStatic: string | undefined
try {
  ffmpegStatic = (await import('ffmpeg-static')).default as unknown as string
} catch {
  /* optional */
}
try {
  ffprobeStatic = ((await import('ffprobe-static')) as unknown as { default: { path: string } }).default.path
} catch {
  /* optional */
}

function findChrome(): string | undefined {
  const base = path.join(os.homedir(), '.cache', 'hyperframes', 'chrome')
  if (!fs.existsSync(base)) return undefined
  const stack = [base]
  let depth = 0
  while (stack.length && depth < 2000) {
    const dir = stack.pop()!
    depth++
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (/^chrome-headless-shell(\.exe)?$/.test(e.name)) return p
    }
  }
  return undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production'
  const dataDir = path.resolve(env.DATA_DIR ?? path.join(SERVER_ROOT, '.data'))
  const whisperDir = path.join(PRODUCER_APP, 'offline', 'tools', 'whisper')
  const whisperCli =
    env.WHISPER_CLI ||
    firstExisting([path.join(whisperDir, 'Release', 'whisper-cli.exe'), path.join(whisperDir, 'Release', 'main.exe'), '/usr/local/bin/whisper-cli'])
  const whisperModel = env.WHISPER_MODEL || firstExisting([path.join(whisperDir, 'ggml-small.en.bin'), '/opt/whisper/ggml-small.en.bin'])
  const producerModels = path.join(PRODUCER_APP, 'offline', 'models')
  const kokoroCache =
    env.KOKORO_CACHE || (fs.existsSync(path.join(producerModels, 'onnx-community', 'Kokoro-82M-v1.0-ONNX')) ? producerModels : path.join(dataDir, 'models'))
  const s3 = env.S3_BUCKET
    ? {
        bucket: env.S3_BUCKET,
        endpoint: env.S3_ENDPOINT || undefined,
        region: env.S3_REGION || 'auto',
        accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
        forcePathStyle: /^(1|true|yes)$/i.test(env.S3_FORCE_PATH_STYLE ?? ''),
      }
    : undefined
  const mode: Mode = env.MODE === 'desktop' ? 'desktop' : 'cloud'
  const aiProvider = (['anthropic-api', 'claude-cli', 'none'].includes(env.AI_PROVIDER ?? '') ? env.AI_PROVIDER : mode === 'desktop' ? 'claude-cli' : 'anthropic-api') as Config['aiProvider']
  let version = '0.0.0'
  try {
    version = (JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8')) as { version: string }).version
  } catch {
    /* keep default */
  }
  return {
    mode,
    aiProvider,
    version,
    port: Number(env.PORT ?? 8787),
    role: (['all', 'api', 'worker'].includes(env.ROLE ?? '') ? env.ROLE : 'all') as Role,
    production,
    dataDir,
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.PGLITE_DIR ?? path.join(dataDir, 'pg'),
    publicUrl: env.PUBLIC_URL || undefined,
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 4096) * 1024 * 1024,
    workerConcurrency: Math.max(1, Number(env.WORKER_CONCURRENCY ?? 2)),
    s3,
    ffmpegPath: env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || ffprobeStatic || 'ffprobe',
    whisperCli,
    whisperModel,
    whisperThreads: Number(env.WHISPER_THREADS ?? Math.max(2, Math.min(8, os.cpus().length - 1))),
    kokoroCache,
    // the user's installed skill wins; apps/server/skill is a vendored snapshot (looks + house rules) for deploys
    producerSkillDir:
      env.PRODUCER_SKILL_DIR ||
      (fs.existsSync(path.join(os.homedir(), '.claude', 'skills', 'producer-pipeline', 'SKILL.md')) ? path.join(os.homedir(), '.claude', 'skills', 'producer-pipeline') : path.join(SERVER_ROOT, 'skill')),
    webDist: env.WEB_DIST || path.join(REPO_ROOT, 'apps', 'web', 'dist'),
    chromePath: env.CHROME_PATH || findChrome(),
    hyperframesProtocolTimeout: env.HYPERFRAMES_PROTOCOL_TIMEOUT || undefined,
  }
}
