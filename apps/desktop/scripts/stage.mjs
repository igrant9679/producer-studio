// Stage everything the packaged app ships outside app.asar, under apps/desktop/build/stage/:
//   server/server.mjs          apps/server bundled with esbuild (native/wasm-heavy packages left external)
//   server/node_modules/       only those external packages + their dependency closure (this platform's binaries only)
//   server/scripts/            tts-worker.mjs, mcp-server.mjs (plain Node scripts, run with Electron-as-Node)
//   server/skill/              vendored producer-pipeline skill (looks + house rules)
//   server/runtime.js          packages/core runtime bundle used by exports (no esbuild at runtime)
//   server/vendor/anidoodle/   the AI-drawing sandbox's media bundle (Apache-2.0) with its LICENSE and NOTICE
//   server/vendor/three/       three.js for the sandbox's 3D drawing styles (MIT) with its LICENSE
//   server/blender/            the harness that runs Blender scene scripts on this computer's Blender
//   web/                       apps/web/dist without sourcemaps
//   tools/                     whisper.cpp + ggml-small.en, Kokoro-82M ONNX, chrome-headless-shell (from build/tools,
//                              filled by scripts/fetch-tools.mjs)
// Nothing from .data, logs, tests or personal paths is copied.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { keepStagedPath } from './release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(root, '..', '..')
const serverSrc = path.join(repo, 'apps', 'server')
const stage = path.join(root, 'build', 'stage')
const out = path.join(stage, 'server')
const t0 = Date.now()

/** Loaded at runtime from node_modules: native addons, wasm, bundled binaries, or files resolved by path. */
const EXTERNAL = [
  '@electric-sql/pglite',
  'kokoro-js',
  'onnxruntime-node',
  '@huggingface/transformers',
  'sharp',
  'ffmpeg-static',
  'ffprobe-static',
  'hyperframes',
  'gsap',
  'roughjs',
  'puppeteer-core',
  ...fs.readdirSync(path.join(repo, 'node_modules', '@fontsource')).map((f) => `@fontsource/${f}`),
]

fs.rmSync(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
fs.mkdirSync(out, { recursive: true })

// ---- 1. server bundle ----
await build({
  entryPoints: [path.join(serverSrc, 'src', 'index.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // esbuild is only imported by the dev-time runtime bundler (RUNTIME_JS replaces it when packaged)
  external: [...EXTERNAL, 'esbuild', 'tsx'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
})

// ---- 2. scripts, skill, runtime, package.json ----
fs.mkdirSync(path.join(out, 'scripts'), { recursive: true })
for (const f of ['tts-worker.mjs', 'mcp-server.mjs']) fs.copyFileSync(path.join(serverSrc, 'scripts', f), path.join(out, 'scripts', f))
fs.cpSync(path.join(serverSrc, 'skill'), path.join(out, 'skill'), { recursive: true })
// the music composer runs as its own process (plain JS, not bundled); the sound effects are files
fs.cpSync(path.join(serverSrc, 'scripts', 'music'), path.join(out, 'scripts', 'music'), { recursive: true, filter: (f) => !f.endsWith('.d.ts') })
fs.cpSync(path.join(serverSrc, 'sfx'), path.join(out, 'sfx'), { recursive: true })
// the AI-drawing sandbox's media (anidoodle, Apache-2.0): the browser bundle, read from disk, with its licence
fs.mkdirSync(path.join(out, 'vendor', 'anidoodle'), { recursive: true })
for (const f of ['anidoodle.js', 'LICENSE', 'NOTICE', 'PROVENANCE.md']) fs.copyFileSync(path.join(serverSrc, 'vendor', 'anidoodle', f), path.join(out, 'vendor', 'anidoodle', f))
// three.js (MIT) for the 3D drawing styles: the browser bundle with its licence
fs.mkdirSync(path.join(out, 'vendor', 'three'), { recursive: true })
for (const f of ['three.js', 'LICENSE', 'PROVENANCE.md']) fs.copyFileSync(path.join(serverSrc, 'vendor', 'three', f), path.join(out, 'vendor', 'three', f))
// Blender scenes: the harness Blender runs the AI's scene scripts with (the RunPod files ride along, unused here)
fs.mkdirSync(path.join(out, 'blender'), { recursive: true })
for (const f of ['harness.py', 'pod.py', 'boot.sh']) fs.copyFileSync(path.join(serverSrc, 'blender', f), path.join(out, 'blender', f))
await build({
  entryPoints: [path.join(repo, 'packages', 'core', 'src', 'runtime.ts')],
  outfile: path.join(out, 'runtime.js'),
  bundle: true,
  format: 'iife',
  globalName: 'ProducerRuntime',
  minify: true,
  target: 'es2020',
  platform: 'browser',
  logLevel: 'warning',
})
const serverPkg = JSON.parse(fs.readFileSync(path.join(serverSrc, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'producer-studio-server', version: serverPkg.version, private: true, type: 'module' }, null, 2))

// ---- 3. node_modules closure ----
const nm = path.join(repo, 'node_modules')
const readPkg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
/** Node resolution of `name` from package dir `from` (nested node_modules first, then parents up to the repo). */
function locate(name, from) {
  let d = from
  for (;;) {
    const cand = path.join(d, 'node_modules', name)
    if (fs.existsSync(path.join(cand, 'package.json'))) return cand
    if (path.resolve(d) === path.resolve(repo)) return null
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}
const topLevel = new Set()
const seen = new Set()
function walk(dir) {
  if (seen.has(dir)) return
  seen.add(dir)
  const rel = path.relative(nm, dir)
  // record top-level packages (nested ones travel with their parent's folder)
  if (!rel.startsWith('..') && !rel.split(path.sep).slice(rel.startsWith('@') ? 2 : 1).includes('node_modules')) topLevel.add(rel)
  const pkg = readPkg(dir)
  for (const dep of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) })) {
    const loc = locate(dep, dir)
    if (loc) walk(loc)
  }
}
for (const name of EXTERNAL) {
  const dir = path.join(nm, name)
  if (!fs.existsSync(dir)) throw new Error(`missing external package ${name}; run npm install`)
  walk(dir)
}

// other platforms' prebuilt binaries, tests, maps and docs stay out (release.mjs; native packages are this machine's)
const keepPath = (p) => keepStagedPath(p, process.platform, process.arch)
let bytes = 0
for (const rel of [...topLevel].sort()) {
  const src = path.join(nm, rel)
  const dst = path.join(out, 'node_modules', rel)
  fs.cpSync(src, dst, {
    recursive: true,
    dereference: true,
    filter: (s) => {
      const r = path.relative(nm, s)
      if (!keepPath(r)) return false
      if (fs.statSync(s).isFile()) bytes += fs.statSync(s).size
      return true
    },
  })
}
console.log(`server: bundle + ${topLevel.size} packages (${(bytes / 1e6).toFixed(0)} MB)`)

// ---- 4. web ----
const webDist = path.join(repo, 'apps', 'web', 'dist')
if (!fs.existsSync(path.join(webDist, 'index.html'))) throw new Error('apps/web/dist is missing: run npm run build -w @producer/web')
fs.cpSync(webDist, path.join(stage, 'web'), { recursive: true, filter: (s) => !s.endsWith('.map') })

// ---- 5. tools ----
const tools = path.join(root, 'build', 'tools')
if (fs.existsSync(tools)) fs.cpSync(tools, path.join(stage, 'tools'), { recursive: true })
else console.warn('build/tools is missing (run npm run fetch-tools -w @producer/desktop): the app will ship without whisper/Kokoro/chrome')

// ---- 6. app icon for electron-builder ----
// Always refreshed from apps/desktop/assets (generated by scripts/brand-icons.mjs) so a stale icon is never reused;
// rasterise the web favicon only when the branded asset is missing.
const res = path.join(root, 'build', 'resources')
fs.mkdirSync(res, { recursive: true })
const iconPng = path.join(res, 'icon.png')
fs.rmSync(iconPng, { force: true })
const brandPng = path.join(root, 'assets', 'icon.png')
if (fs.existsSync(brandPng)) fs.copyFileSync(brandPng, iconPng)
else {
  const sharp = (await import('sharp')).default
  await sharp(path.join(repo, 'apps', 'web', 'public', 'favicon.svg'), { density: 1024 }).resize(512, 512).png().toFile(iconPng)
}
const brandIco = path.join(root, 'assets', 'icon.ico')
if (fs.existsSync(brandIco)) fs.copyFileSync(brandIco, path.join(res, 'icon.ico'))
for (const f of ['site.webmanifest', 'favicon.ico', 'favicon.svg', 'icons/icon-192.png'])
  if (fs.existsSync(path.join(webDist, f)) && !fs.existsSync(path.join(stage, 'web', f))) throw new Error(`web bundle is missing ${f}`)
console.log(`staged apps/desktop/build/stage in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
