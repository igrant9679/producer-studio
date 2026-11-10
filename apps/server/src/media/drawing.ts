// AI-drawn animation scenes: drawing code the space's AI wrote (ai/drawn.ts) run frame by frame in a headless Chrome
// sandbox and encoded to an mp4, which the timeline then uses like any clip (so the preview and the export match).
//
// The contract the code follows: it defines `function draw(ctx, t, env)`, which paints the WHOLE frame on a canvas
// 2D context for time `t` (seconds from the scene's start), from `t` alone: no state kept between calls, no timers, no
// DOM, no network. `env` (below, `ENV_HELPERS`) holds the size, the brand palette and fonts, the narration's word
// timings, Rough.js (hand-drawn shapes, MIT, roughjs.com), easing helpers, and anidoodle's art core (Apache-2.0,
// vendor/anidoodle: pencil, ink, riso and chalk media, watercolour washes, shaded forms, paper textures, strokes that
// draw themselves, hatching), with `env.memo` to build marks once per page.
//
// The code is the model's, and the model read text a person typed, so it is treated as hostile:
//   - the page has a CSP that allows inline script and nothing else (no fetch, no images or fonts from anywhere
//     but data: URLs, no WebSocket), and the network APIs are removed before the code runs;
//   - Chrome is started with a proxy that goes nowhere (every request fails, loopback included) and WebRTC kept off
//     UDP; every request the page makes is aborted as well;
//   - Math.random is seeded and the clocks read the frame's time, so frames are the same every render;
//   - a frame that takes longer than FRAME_TIMEOUT_MS (an endless loop) ends the run, and the browser is killed.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { SERVER_ROOT } from '../config'
import { ctx } from '../context'
import { HttpError } from '../http'
import { CancelledError } from '../jobs/worker'
import { log } from '../log'
import { buildFontFaces } from '../render/fonts'
import { tmpDir } from '../services/assets'

const require = createRequire(import.meta.url)

/** A frame that takes longer than this (an endless loop, a huge fill) stops the drawing. */
const FRAME_TIMEOUT_MS = 8_000
/** The whole render of one scene. */
const RENDER_TIMEOUT_MS = 6 * 60_000

export interface DrawingEnv {
  width: number
  height: number
  /** Scene length in seconds. */
  duration: number
  fps: number
  /** The narration's words, seconds from the scene's start. */
  words: Array<{ w: string; start: number; end?: number }>
  palette: { canvas: string; accent: string; ink: string }
  fonts: { headline: string; body: string }
  /** Pictures the code may read with env.image(name): data: URLs (PNG or JPEG), decoded before the first frame. */
  images?: Record<string, string>
}

/** The drawing code failed: a compile error, an error thrown at `t`, or a frame that never finished. */
export class DrawingError extends Error {
  constructor(
    message: string,
    readonly at?: number,
  ) {
    super(message)
  }
}

let roughSource: string | undefined
function rough(): string {
  roughSource ??= fs.readFileSync(path.join(path.dirname(require.resolve('roughjs/package.json')), 'bundled', 'rough.js'), 'utf8')
  return roughSource
}

/** anidoodle's art core, bundled (vendor/anidoodle/anidoodle.js, built by scripts/build-anidoodle.mjs). */
export const ANIDOODLE_JS = () => path.join(SERVER_ROOT, 'vendor', 'anidoodle', 'anidoodle.js')
let doodleSource: string | undefined
function anidoodle(): string {
  // a closing tag inside the bundle's strings would end the script early
  doodleSource ??= fs.readFileSync(ANIDOODLE_JS(), 'utf8').replace(/<\/script/gi, '<\\/script')
  return doodleSource
}

/** @font-face rules for the look's fonts (Latin faces, inlined as data: URLs: the page loads nothing). */
function fontCss(env: DrawingEnv, work: string): string {
  const uses = [...new Set([env.fonts.headline, env.fonts.body, 'Inter'])].flatMap((family) => [400, 700, 900].map((weight) => ({ family, weight, italic: false })))
  const { css } = buildFontFaces(uses, work, 'fonts')
  return css
    .split('\n')
    .filter((rule) => /-latin-\d/.test(rule))
    .map((rule) =>
      rule.replace(/url\('fonts\/([^']+)'\)/, (_m, file: string) => {
        const data = fs.readFileSync(path.join(work, 'fonts', file)).toString('base64')
        return `url(data:font/woff2;base64,${data})`
      }),
    )
    .join('\n')
}

/** Helpers every drawing gets as `env` (documented for the model in ai/drawn.ts). Runs in the page. */
const ENV_HELPERS = `
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = {
  linear: (k) => k,
  in: (k) => k * k * k,
  out: (k) => 1 - Math.pow(1 - k, 3),
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  back: (k) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); },
  elastic: (k) => (k === 0 || k === 1 ? k : Math.pow(2, -10 * k) * Math.sin((k * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
};
const progress = (t, start, dur = 0.6, e = ease.out) => e(clamp((t - start) / Math.max(1e-6, dur)));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9%$]+/g, '');
const wordAt = (text, after = 0) => {
  const want = norm(text);
  for (const w of ENV.words) if (w.start >= after - 1e-6 && norm(w.w) === want) return w.start;
  for (const w of ENV.words) if (w.start >= after - 1e-6 && want.length > 3 && norm(w.w).startsWith(want.slice(0, 4))) return w.start;
  return undefined;
};
const rand = (seed) => { let s = (seed >>> 0) || 1; return () => { s = (s + 0x6d2b79f5) >>> 0; let x = s; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; };
// a value built once per page and reused by every frame: it must depend on its key alone (never on t)
const MEMO = new Map();
const memo = (key, build) => { const k = String(key); if (!MEMO.has(k)) MEMO.set(k, build()); return MEMO.get(k); };
// anidoodle (window.anidoodle, Apache-2.0): its surfaces and caches come from the host, as its contract asks
const AD = window.anidoodle;
const IMAGES = {};
const surface = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }) }; };
const DENV = { W: ENV.width, H: ENV.height, scale: 1, canvas: surface, cache: new Map(), image: (name) => IMAGES[name] };
const MEDIA = {
  pencil: AD.core.PENCIL,
  riso: AD.core.RISOLINE,
  ink: { nib: 1.15, taper: 0.85, pressure: 0.6, retrace: false, wobble: 0.5, rough: 0.35 },
  chalk: { nib: 2.2, taper: 0.35, pressure: 0.8, retrace: true, wobble: 1.4, rough: 2.4 },
  marker: { nib: 2.4, taper: 0.12, pressure: 0.25, retrace: false, wobble: 0.6, rough: 0.3 },
};
const doodle = (ctx, t, medium = 'pencil') => new AD.core.Gfx(ctx, DENV, Math.round(t * ENV.fps), typeof medium === 'string' ? (MEDIA[medium] || MEDIA.pencil) : { ...MEDIA.pencil, ...medium });
const C = AD.core, M = AD.marks;
const shapes = Object.freeze({ rng: C.rng, fractal: C.fractal, jitter: C.jitter, sample: C.sample, oval: C.oval, softBox: C.softBox, arc: C.arc, line: C.line, turn: C.turn, poly: C.poly, heart: C.heart, tube: C.tube, displace: C.displace, halftone: C.halftone, GRAPHITE: C.GRAPHITE, TINT: C.TINT });
// lay a list of marks down one after another between two times, each taking time by its length (its cost)
const play = (ctx, inks, t, start, end) => {
  let total = 0;
  for (const m of inks) total += m.cost;
  let left = clamp((t - start) / Math.max(1e-6, end - start)) * (total || 1);
  for (const m of inks) {
    if (left <= 0) break;
    m.draw(ctx, Math.min(1, left / m.cost));
    left -= m.cost;
  }
};
const marks = Object.freeze({ stroke: M.stroke, hatch: M.hatch, contour: M.contour, sketchEllipse: M.sketchEllipse, guideLine: M.guideLine, scribbleDot: M.scribbleDot, polyR: M.polyR, ellR: M.ellR, union: M.union, minus: M.minus, inter: M.inter, edgeDist: M.edgeDist, ellipsePts: M.ellipsePts, lengthOf: M.lengthOf, play });
`

function page(code: string, env: DrawingEnv, fonts: string): string {
  // JSON in a script: "<" escaped so nothing in it can close the tag
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'">
<style>${fonts}
html,body{margin:0;padding:0;overflow:hidden;background:${/^#[0-9a-f]{3,8}$/i.test(env.palette.canvas) ? env.palette.canvas : '#000'}}canvas{display:block}</style></head>
<body><canvas id="c" width="${env.width}" height="${env.height}"></canvas>
<script>${rough()}</script>
<script>${anidoodle()}</script>
<script>
(() => {
  const ENV = ${json(env)};
  ${ENV_HELPERS}
  for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'Worker', 'SharedWorker', 'open', 'importScripts']) {
    try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  }
  try { Object.defineProperty(navigator, 'sendBeacon', { value: undefined }); } catch (e) {}
  let now = 0;
  Date.now = () => now * 1000;
  performance.now = () => now * 1000;
  window.requestAnimationFrame = () => 0;
  window.setTimeout = window.setInterval = () => 0;
  const canvas = document.getElementById('c');
  const g = canvas.getContext('2d');
  const { images: _images, ...plain } = ENV;
  const env = Object.freeze({
    ...plain, W: ENV.width, H: ENV.height, rough: rough.canvas(canvas), clamp, lerp, ease, progress, wordAt, rand, memo, doodle, shapes, marks,
    image: (name) => IMAGES[name], surface, lib: AD, doodleEnv: DENV,
  });
  let draw;
  try {
    draw = new Function('env', ${json(code)} + '\\n;return typeof draw === "function" ? draw : undefined;')(env);
    if (!draw) window.__compileError = 'The code does not define function draw(ctx, t, env).';
  } catch (e) {
    window.__compileError = String((e && e.message) || e);
  }
  // the pictures are decoded before the first frame (data: URLs only: the page loads nothing else)
  const pictures = Object.entries(ENV.images || {}).map(([name, src]) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { IMAGES[name] = img; resolve(true); };
    img.onerror = () => resolve(false);
    img.src = String(src).startsWith('data:image/') ? src : '';
  }));
  window.__ready = Promise.all([...pictures, ...[ENV.fonts.headline, ENV.fonts.body].map((f) => Promise.all([400, 700, 900].map((w) => document.fonts.load(w + ' 40px "' + f + '"').catch(() => null))))]).then(() => true);
  window.__frame = (t, jpeg) => {
    if (window.__compileError) return 'error:' + window.__compileError;
    now = t;
    // the same random numbers every frame (the code asks env.rand for anything that should change)
    const r = rand(20261102);
    Math.random = r;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.filter = 'none';
    g.fillStyle = ENV.palette.canvas;
    g.fillRect(0, 0, ENV.width, ENV.height);
    g.save();
    try {
      draw(g, t, env);
    } catch (e) {
      g.restore();
      return 'error:' + String((e && e.message) || e);
    }
    g.restore();
    return jpeg ? canvas.toDataURL('image/jpeg', 0.92) : 'ok';
  };
})();
</script></body></html>`
}

type Browser = import('puppeteer-core').Browser
type Page = import('puppeteer-core').Page

async function open(code: string, env: DrawingEnv, work: string): Promise<{ browser: Browser; page: Page }> {
  const executablePath = ctx().config.chromePath
  if (!executablePath || !fs.existsSync(executablePath)) throw new HttpError(503, 'server', 'AI-drawn animation needs the export’s browser, which isn’t on this server yet.')
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    protocolTimeout: FRAME_TIMEOUT_MS + 4_000,
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--disable-dev-shm-usage',
      // every request goes to a proxy that isn't there: nothing leaves the machine, loopback included
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--mute-audio',
      '--hide-scrollbars',
      '--font-render-hinting=none',
      `--window-size=${env.width},${env.height}`,
    ],
  })
  try {
    const p = await browser.newPage()
    await p.setRequestInterception(true)
    p.on('request', (r) => {
      if (r.url().startsWith('data:') || r.url() === 'about:blank') void r.continue()
      else void r.abort('blockedbyclient')
    })
    await p.setViewport({ width: env.width, height: env.height, deviceScaleFactor: 1 })
    await p.setContent(page(code, env, fontCss(env, work)), { waitUntil: 'load', timeout: 30_000 })
    await p.evaluate('window.__ready')
    return { browser, page: p }
  } catch (err) {
    await close(browser)
    throw err
  }
}

async function close(browser: Browser) {
  const proc = browser.process()
  await Promise.race([browser.close().catch(() => undefined), new Promise((r) => setTimeout(r, 3_000))])
  if (proc && proc.exitCode === null) proc.kill('SIGKILL')
}

async function frame(p: Page, t: number, jpeg: boolean): Promise<Buffer | null> {
  let out: string
  try {
    out = (await p.evaluate((tt: number, j: boolean) => (window as unknown as { __frame: (t: number, j: boolean) => string }).__frame(tt, j), t, jpeg)) as string
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new DrawingError(/timed out/i.test(msg) ? `A frame took longer than ${FRAME_TIMEOUT_MS / 1000} s to draw (an endless loop?)` : msg.slice(0, 300), t)
  }
  if (out.startsWith('error:')) throw new DrawingError(out.slice(6).slice(0, 400), t)
  return jpeg ? Buffer.from(out.slice(out.indexOf(',') + 1), 'base64') : null
}

/**
 * Draw a few frames to see that the code runs and what it shows: JPEGs at `times` (seconds). Throws DrawingError
 * with what went wrong.
 */
export async function testDrawing(code: string, env: DrawingEnv, times: number[], signal?: AbortSignal): Promise<Buffer[]> {
  const work = tmpDir('drawing')
  const { browser, page: p } = await open(code, env, work)
  const onAbort = () => void close(browser)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // every frame runs (an error anywhere shows up), and the asked-for ones are kept
    const step = 1 / Math.min(env.fps, 10)
    const last = Math.max(0, Math.ceil(env.duration / step) - 1)
    const at = (t: number) => Math.min(last, Math.max(0, Math.round(t / step)))
    const want = new Set(times.map(at))
    const shots = new Map<number, Buffer>()
    for (let i = 0; i <= last; i++) {
      if (signal?.aborted) throw new CancelledError()
      const shot = await frame(p, i * step, want.has(i))
      if (shot) shots.set(i, shot)
    }
    // one per time asked for, in that order
    return times.map((t) => shots.get(at(t))!)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await close(browser)
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}

/** Render the whole drawing to an H.264 mp4 at env.fps (opaque, the canvas colour behind it). */
export async function renderDrawing(code: string, env: DrawingEnv, outFile: string, opts: { signal?: AbortSignal; onProgress?: (f: number) => void } = {}): Promise<void> {
  const work = tmpDir('drawing')
  const { browser, page: p } = await open(code, env, work)
  const timer = setTimeout(() => void close(browser), RENDER_TIMEOUT_MS)
  const onAbort = () => void close(browser)
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const frames = Math.max(1, Math.ceil(env.duration * env.fps))
  // frames go straight to ffmpeg as a stream of JPEGs
  const enc = spawn(ctx().config.ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-f', 'image2pipe', '-framerate', String(env.fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', outFile], { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  enc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
  const done = new Promise<number>((resolve) => enc.on('close', (c) => resolve(c ?? 1)))
  try {
    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) throw new CancelledError()
      const jpg = (await frame(p, i / env.fps, true))!
      if (!enc.stdin.write(jpg)) await new Promise((r) => enc.stdin.once('drain', r))
      if (i % 15 === 0) opts.onProgress?.(i / frames)
    }
    enc.stdin.end()
    const code_ = await done
    if (code_ !== 0) {
      log.warn('drawing encode failed', { stderr })
      throw new HttpError(502, 'server', 'The drawing could not be made into a video.')
    }
  } catch (err) {
    enc.kill('SIGKILL')
    fs.rmSync(outFile, { force: true })
    if (opts.signal?.aborted) throw new CancelledError()
    throw err
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
    await close(browser)
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}
