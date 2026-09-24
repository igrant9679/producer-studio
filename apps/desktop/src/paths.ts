// Where things live, in dev (repo checkout) and packaged (electron-builder resources) builds.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'

export const isDev = !app.isPackaged

/** Repo root in dev (dist/main.cjs → apps/desktop → apps → repo). */
export const repoRoot = path.resolve(__dirname, '..', '..', '..')

export function resources(...p: string[]): string {
  return path.join(process.resourcesPath, ...p)
}

export interface Layout {
  /** Arguments for Electron-as-Node to start the server. */
  serverArgs: string[]
  serverCwd: string
  /** Extra env for the server (resource locations). */
  serverEnv: Record<string, string>
}

function firstExisting(...ps: string[]): string | undefined {
  return ps.find((p) => fs.existsSync(p))
}

function findUnder(dir: string, name: RegExp, depth = 4): string | undefined {
  if (!fs.existsSync(dir)) return undefined
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isFile() && name.test(e.name)) return p
    if (e.isDirectory() && depth > 0) {
      const hit = findUnder(p, name, depth - 1)
      if (hit) return hit
    }
  }
  return undefined
}

export function layout(): Layout {
  if (isDev) {
    const server = path.join(repoRoot, 'apps', 'server')
    const tsx = require.resolve('tsx', { paths: [server] })
    return {
      serverArgs: ['--import', pathToFileURL(tsx).href, path.join(server, 'src', 'index.ts')],
      serverCwd: server,
      // dev: the server's own config finds whisper/Kokoro/chrome (Producer offline copies, ~/.cache/hyperframes)
      serverEnv: { WEB_DIST: path.join(repoRoot, 'apps', 'web', 'dist') },
    }
  }
  const server = resources('server')
  const tools = resources('tools')
  const env: Record<string, string> = {
    PS_SERVER_ROOT: server,
    WEB_DIST: resources('web'),
    RUNTIME_JS: path.join(server, 'runtime.js'),
    PRODUCER_MCP_SCRIPT: path.join(server, 'scripts', 'mcp-server.mjs'),
    PRODUCER_SKILL_DIR: path.join(server, 'skill'),
  }
  const whisper = firstExisting(path.join(tools, 'whisper', 'whisper-cli.exe'), path.join(tools, 'whisper', 'Release', 'whisper-cli.exe'), path.join(tools, 'whisper', 'whisper-cli'))
  const model = firstExisting(path.join(tools, 'whisper', 'ggml-small.en.bin'))
  if (whisper && model) {
    env.WHISPER_CLI = whisper
    env.WHISPER_MODEL = model
  }
  if (fs.existsSync(path.join(tools, 'models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX'))) env.KOKORO_CACHE = path.join(tools, 'models')
  const chrome = findUnder(path.join(tools, 'chrome'), /^chrome-headless-shell(\.exe)?$/)
  if (chrome) env.CHROME_PATH = chrome
  return { serverArgs: [path.join(server, 'server.mjs')], serverCwd: server, serverEnv: env }
}
