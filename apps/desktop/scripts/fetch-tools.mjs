// Fill apps/desktop/build/tools with the offline tools the installer bundles:
//   whisper/        whisper-cli.exe + its DLLs, ggml-small.en.bin
//   models/onnx-community/Kokoro-82M-v1.0-ONNX/   config, tokenizer, onnx/model_quantized.onnx
//   chrome/         chrome-headless-shell (win64) for HyperFrames rendering
// Local builds copy from existing installs (env overrides first, then the Producer 0.1 offline bundle and the
// HyperFrames browser cache). CI passes --download to fetch pinned upstream artefacts instead (see docs/desktop.md):
// every download is checked against the sha256 below before it is used, Hugging Face files come from a fixed commit
// (resolve/<sha>, never the movable `main`), and @puppeteer/browsers runs at an exact version.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = path.join(root, 'build', 'tools')
const download = process.argv.includes('--download')
const home = os.homedir()
const producerOffline = path.join(home, 'AppData', 'Local', 'Programs', 'Producer', 'resources', 'app', 'resources', 'offline')

// Pinned upstream sources for CI (--download). To move a pin: take the new release's asset digest from the GitHub
// release API, or the new Hugging Face commit (GET https://huggingface.co/api/models/<repo>/revision/main → sha) and
// each file's sha256 (POST https://huggingface.co/api/models/<repo>/paths-info/<sha> {"paths":[…]} → lfs.oid; small
// non-LFS files: sha256 of the file itself) — no need to download the large files to pin them.
const WHISPER_ZIP = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip',
  sha256: '0d2eca299c248f965bd0341bcb219db4b433c7f0c0ce2200d4df85765e8156a9',
}
const WHISPER_REPO = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1'
const WHISPER_MODEL = { url: `${WHISPER_REPO}/ggml-small.en.bin`, sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d' }
const KOKORO_REPO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231'
const KOKORO_FILES = {
  'config.json': 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
  'tokenizer.json': '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  'tokenizer_config.json': 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
  'onnx/model_quantized.onnx': 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
}
// the version the repo's lockfile already resolves (via hyperframes / puppeteer-core); Chrome for Testing publishes no
// checksums, so the browser itself is pinned by version and fetched over https from Google's storage
const PUPPETEER_BROWSERS = '@puppeteer/browsers@3.2.3'
const CHROME_VERSION = process.env.CHROME_HEADLESS_SHELL_VERSION || '152.0.7977.30'

const exists = (p) => p && fs.existsSync(p)
const firstDir = (...ps) => ps.find((p) => exists(p))

async function sha256File(file) {
  const h = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) h.update(chunk)
  return h.digest('hex')
}

/** Download to `file`, streaming through sha256; the file only appears under its name if the hash matches. */
async function fetchVerified({ url, sha256 }, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${url} → HTTP ${res.status}`)
  const tmp = `${file}.part`
  const h = createHash('sha256')
  const out = fs.createWriteStream(tmp)
  try {
    for await (const chunk of res.body) {
      h.update(chunk)
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
    }
  } finally {
    await new Promise((r) => out.end(r))
  }
  const got = h.digest('hex')
  if (got !== sha256) {
    fs.rmSync(tmp, { force: true })
    throw new Error(`${url}: sha256 ${got} does not match the pinned ${sha256}`)
  }
  fs.renameSync(tmp, file)
}

/** In --download mode a cached file must still match its pin (a stale or tampered CI cache is fetched again). */
async function cachedOk(file, sha256) {
  if (!exists(file)) return false
  if (!download) return true
  if ((await sha256File(file)) === sha256) return true
  console.warn(`${path.relative(dest, file)}: cached copy doesn't match its pinned sha256; fetching it again`)
  fs.rmSync(file, { force: true })
  return false
}

async function whisper() {
  const out = path.join(dest, 'whisper')
  const model = path.join(out, 'ggml-small.en.bin')
  fs.mkdirSync(out, { recursive: true })
  if (download) {
    // the CLI zip is small: fetched and checked every run, so the binaries always come out of the pinned release
    const zip = path.join(os.tmpdir(), 'whisper-bin-x64.zip')
    await fetchVerified(WHISPER_ZIP, zip)
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${zip}' '${out}'`])
    if (await cachedOk(model, WHISPER_MODEL.sha256)) return 'ok (model cached)'
    await fetchVerified(WHISPER_MODEL, model)
    return 'ok'
  }
  if (exists(path.join(out, 'whisper-cli.exe')) && exists(model)) return 'cached'
  const src = firstDir(process.env.WHISPER_DIR, path.join(producerOffline, 'tools', 'whisper'))
  if (!src) throw new Error('whisper not found: set WHISPER_DIR or run with --download')
  const bin = exists(path.join(src, 'Release', 'whisper-cli.exe')) ? path.join(src, 'Release') : src
  // the CLI and its DLLs only (no tests, demos or other tools)
  for (const f of fs.readdirSync(bin)) if (f === 'whisper-cli.exe' || /\.dll$/i.test(f)) fs.copyFileSync(path.join(bin, f), path.join(out, f))
  fs.copyFileSync(path.join(src, 'ggml-small.en.bin'), model)
  return 'ok'
}

async function kokoro() {
  const rel = path.join('models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX')
  const out = path.join(dest, rel)
  if (download) {
    let fetched = 0
    for (const [f, sha256] of Object.entries(KOKORO_FILES)) {
      const file = path.join(out, f)
      if (await cachedOk(file, sha256)) continue
      await fetchVerified({ url: `${KOKORO_REPO}/${f}`, sha256 }, file)
      fetched++
    }
    return fetched ? 'ok' : 'cached'
  }
  if (exists(path.join(out, 'onnx', 'model_quantized.onnx'))) return 'cached'
  const src = firstDir(process.env.KOKORO_DIR, path.join(producerOffline, rel))
  if (!src) throw new Error('Kokoro model not found: set KOKORO_DIR or run with --download')
  fs.cpSync(src, out, { recursive: true })
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
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', PUPPETEER_BROWSERS, 'install', `chrome-headless-shell@${CHROME_VERSION}`, '--path', cache], { stdio: 'inherit', shell: process.platform === 'win32' })
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
