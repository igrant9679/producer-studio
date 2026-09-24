// Fill apps/desktop/build/tools with the offline tools the installer bundles:
//   whisper/        whisper-cli.exe + its DLLs, ggml-small.en.bin
//   models/onnx-community/Kokoro-82M-v1.0-ONNX/   config, tokenizer, onnx/model_quantized.onnx
//   chrome/         chrome-headless-shell (win64) for HyperFrames rendering
// Local builds copy from existing installs (env overrides first, then the Producer 0.1 offline bundle and the
// HyperFrames browser cache). CI passes --download to fetch pinned upstream artefacts instead (see docs/desktop.md).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = path.join(root, 'build', 'tools')
const download = process.argv.includes('--download')
const home = os.homedir()
const producerOffline = path.join(home, 'AppData', 'Local', 'Programs', 'Producer', 'resources', 'app', 'resources', 'offline')

// pinned upstream sources for CI (--download)
const WHISPER_ZIP = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip'
const WHISPER_MODEL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin'
const KOKORO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main'
const CHROME_VERSION = process.env.CHROME_HEADLESS_SHELL_VERSION || '152.0.7977.30'

const exists = (p) => p && fs.existsSync(p)
const firstDir = (...ps) => ps.find((p) => exists(p))

async function fetchTo(url, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}

async function whisper() {
  const out = path.join(dest, 'whisper')
  if (exists(path.join(out, 'whisper-cli.exe')) && exists(path.join(out, 'ggml-small.en.bin'))) return 'cached'
  fs.mkdirSync(out, { recursive: true })
  if (download) {
    const zip = path.join(os.tmpdir(), 'whisper-bin-x64.zip')
    await fetchTo(WHISPER_ZIP, zip)
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${zip}' '${out}'`])
    await fetchTo(WHISPER_MODEL, path.join(out, 'ggml-small.en.bin'))
  } else {
    const src = firstDir(process.env.WHISPER_DIR, path.join(producerOffline, 'tools', 'whisper'))
    if (!src) throw new Error('whisper not found: set WHISPER_DIR or run with --download')
    const bin = exists(path.join(src, 'Release', 'whisper-cli.exe')) ? path.join(src, 'Release') : src
    // the CLI and its DLLs only (no tests, demos or other tools)
    for (const f of fs.readdirSync(bin)) if (f === 'whisper-cli.exe' || /\.dll$/i.test(f)) fs.copyFileSync(path.join(bin, f), path.join(out, f))
    fs.copyFileSync(path.join(src, 'ggml-small.en.bin'), path.join(out, 'ggml-small.en.bin'))
  }
  return 'ok'
}

async function kokoro() {
  const rel = path.join('models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX')
  const out = path.join(dest, rel)
  if (exists(path.join(out, 'onnx', 'model_quantized.onnx'))) return 'cached'
  if (download) {
    for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) await fetchTo(`${KOKORO}/${f}`, path.join(out, f))
  } else {
    const src = firstDir(process.env.KOKORO_DIR, path.join(producerOffline, rel))
    if (!src) throw new Error('Kokoro model not found: set KOKORO_DIR or run with --download')
    fs.cpSync(src, out, { recursive: true })
  }
  return 'ok'
}

function newestChrome(base) {
  if (!exists(base)) return undefined
  const dirs = fs.readdirSync(base).filter((d) => /^win64-/.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const d of dirs) {
    const p = path.join(base, d, 'chrome-headless-shell-win64')
    if (exists(path.join(p, 'chrome-headless-shell.exe'))) return p
  }
  return undefined
}

async function chrome() {
  const out = path.join(dest, 'chrome')
  if (exists(path.join(out, 'chrome-headless-shell.exe'))) return 'cached'
  let src = process.env.CHROME_DIR || newestChrome(path.join(home, '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell'))
  if (!src && download) {
    const cache = path.join(os.tmpdir(), 'ps-chrome')
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '@puppeteer/browsers', 'install', `chrome-headless-shell@${CHROME_VERSION}`, '--path', cache], { stdio: 'inherit', shell: process.platform === 'win32' })
    src = newestChrome(path.join(cache, 'chrome-headless-shell'))
  }
  if (!src) throw new Error('chrome-headless-shell not found: set CHROME_DIR or run with --download')
  fs.cpSync(src, out, { recursive: true })
  return 'ok'
}

fs.mkdirSync(dest, { recursive: true })
for (const [name, fn] of [
  ['whisper', whisper],
  ['kokoro', kokoro],
  ['chrome', chrome],
]) {
  const r = await fn()
  console.log(`${name}: ${r}`)
}
