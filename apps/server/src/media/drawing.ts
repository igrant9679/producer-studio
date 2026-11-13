// AI-drawn animation scenes: drawing code the space's AI wrote (ai/drawn.ts) run frame by frame in a headless Chrome
// sandbox and encoded to an mp4, which the timeline then uses like any clip (so the preview and the export match).
//
// The contract the code follows: it defines `function draw(ctx, t, env)`, which paints the WHOLE frame on a canvas
// 2D context for time `t` (seconds from the scene's start), from `t` alone: no state kept between calls, no timers, no
// DOM, no network. `env` (below, `ENV_HELPERS`) holds the size, the brand palette and fonts, the narration's word
// timings, Rough.js (hand-drawn shapes, MIT, roughjs.com), easing helpers, and anidoodle's art core (Apache-2.0,
// vendor/anidoodle: pencil, ink, riso and chalk media, watercolour washes, shaded forms, paper textures, strokes that
// draw themselves, hatching), with `env.memo` to build marks once per page. Drawings that use 3D (`env.stage3d`, the 3D
// drawing styles) also get three.js (MIT, vendor/three) and a lit studio stage; their page renders WebGL on Chrome's
// software renderer (SwiftShader), so no GPU is needed and every machine draws the same frames.
//
// The code is the model's, and the model read text a person typed, so it is treated as hostile:
//   - the page has a CSP that allows inline script and nothing else (no fetch, no images or fonts from anywhere
//     but data: URLs, no WebSocket), and the network APIs are removed before the code runs;
//   - Chrome is started with a proxy that goes nowhere (every request fails, loopback included) and WebRTC kept off
//     UDP; every request the page makes is aborted as well;
//   - Math.random is seeded and the clocks read the frame's time, so frames are the same every render;
//   - a frame that takes longer than FRAME_TIMEOUT_MS (an endless loop) ends the run, and the browser is killed;
//   - WebGL (SwiftShader) is switched on only for a drawing whose code uses 3D: a smaller surface for all the rest.
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
/** A 3D drawing's frames: the first compiles its shaders and lights on the software renderer, which takes a while. */
const FRAME_TIMEOUT_3D_MS = 90_000
const frameTimeout = (code: string) => (uses3d(code) ? FRAME_TIMEOUT_3D_MS : FRAME_TIMEOUT_MS)
/** The whole render of one scene (a 3D one draws about four frames a second at 1080p in software, after ~25 s to start). */
const RENDER_TIMEOUT_MS = 6 * 60_000
const RENDER_TIMEOUT_3D_MS = 15 * 60_000

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

/** three.js r186 with RoomEnvironment and RoundedBoxGeometry, bundled (vendor/three/three.js, scripts/build-three.mjs). */
export const THREE_JS = () => path.join(SERVER_ROOT, 'vendor', 'three', 'three.js')
let threeSource: string | undefined
function three(): string {
  threeSource ??= fs.readFileSync(THREE_JS(), 'utf8').replace(/<\/script/gi, '<\\/script')
  return threeSource
}

/** Our sandbox add-ons (apps/server/sandbox, shipped like the vendored bundles): the 3D rigged character (three.js),
 * the Lottie motion-graphics builder (with lottie-web, vendor/lottie) and the Open Peeps 2D characters (vendor/peeps).
 * Each loads only on pages whose code uses it. */
export const SANDBOX_DIR = () => path.join(SERVER_ROOT, 'sandbox')
let rigSource: string | undefined
function rigJs(): string {
  rigSource ??= fs.readFileSync(path.join(SANDBOX_DIR(), 'rig.js'), 'utf8').replace(/<\/script/gi, '<\\/script')
  return rigSource
}
let lottieSource: string | undefined
function lottieJs(): string {
  lottieSource ??= [path.join(SERVER_ROOT, 'vendor', 'lottie', 'lottie.js'), path.join(SANDBOX_DIR(), 'lottie-mg.js')]
    .map((f) => `<script>${fs.readFileSync(f, 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`)
    .join('\n')
  return lottieSource
}
let peepsSource: string | undefined
function peepsJs(): string {
  if (peepsSource === undefined) {
    // the art is JSON: "<" can't occur in it, but escape it anyway so nothing in it can close the tag
    const data = fs.readFileSync(path.join(SERVER_ROOT, 'vendor', 'peeps', 'peeps.json'), 'utf8').replace(/</g, '\\u003c')
    const rig = fs.readFileSync(path.join(SANDBOX_DIR(), 'peeps.js'), 'utf8').replace(/<\/script/gi, '<\\/script')
    peepsSource = `<script>window.__peepsData = ${data};</script>\n<script>${rig}</script>`
  }
  return peepsSource
}

/** The drawing uses 3D: its page loads three.js and its browser gets WebGL (env.character needs the 3D stage too). */
export const uses3d = (code: string) => /\benv\s*\.\s*(stage3d|THREE|material3d|character)\b/.test(code)
/** The drawing uses the Lottie motion-graphics engine: its page loads that bundle. */
export const usesLottie = (code: string) => /\benv\s*\.\s*(motionGraphics|lottie)\b/.test(code)
/** The drawing uses Open Peeps characters: its page loads their art and the 2D rig. */
export const usesPeeps = (code: string) => /\benv\s*\.\s*(peep|peeps)\b/.test(code)

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
// 3D (window.THREE, three.js, only on pages of drawings that use it): one WebGL renderer for the page, stages built
// once (env.memo) and posed from t every frame, rendered with a transparent background over the 2D frame
const T3 = window.THREE;
let R3;
const renderer3d = () => {
  if (R3) return R3;
  if (!T3) throw new Error('3D is not loaded on this page: use env.stage3d in the code so the page loads it');
  const c = document.createElement('canvas');
  c.width = ENV.width; c.height = ENV.height;
  let r;
  try {
    r = new T3.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch (e) {
    throw new Error('3D (WebGL) is not available in this browser');
  }
  r.setPixelRatio(1);
  r.setSize(ENV.width, ENV.height, false);
  r.setClearColor(0x000000, 0);
  r.outputColorSpace = T3.SRGBColorSpace;
  r.toneMapping = T3.ACESFilmicToneMapping;
  r.toneMappingExposure = 1;
  r.shadowMap.enabled = true;
  r.shadowMap.type = T3.PCFSoftShadowMap;
  R3 = r;
  return r;
};
const MATS = new Map();
// a few good materials, shared: clay, plastic, glossy, metal, glass, matte, glow
const material3d = (color, kind = 'plastic', extra = {}) => {
  const k = String(color) + '|' + kind + '|' + JSON.stringify(extra);
  if (MATS.has(k)) return MATS.get(k);
  const c = new T3.Color(color);
  const base = { color: c, ...extra };
  const m =
    kind === 'clay' ? new T3.MeshStandardMaterial({ roughness: 0.92, metalness: 0, ...base })
    : kind === 'matte' ? new T3.MeshStandardMaterial({ roughness: 0.7, metalness: 0, ...base })
    : kind === 'glossy' ? new T3.MeshPhysicalMaterial({ roughness: 0.18, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, ...base })
    : kind === 'metal' ? new T3.MeshStandardMaterial({ roughness: 0.28, metalness: 1, ...base })
    : kind === 'glass' ? new T3.MeshPhysicalMaterial({ roughness: 0.04, metalness: 0, transmission: 1, thickness: 0.6, ior: 1.45, transparent: true, ...base })
    : kind === 'glow' ? new T3.MeshStandardMaterial({ roughness: 0.4, emissive: c, emissiveIntensity: 1.6, ...base })
    : new T3.MeshPhysicalMaterial({ roughness: 0.38, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.3, ...base });
  MATS.set(k, m);
  return m;
};
const stage3d = (name, build, opts = {}) => memo('stage3d:' + name, () => {
  const renderer = renderer3d();
  const scene = new T3.Scene();
  const pmrem = new T3.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new T3.RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = opts.environment ?? 0.85;
  if (opts.background) scene.background = new T3.Color(opts.background);
  const camera = new T3.PerspectiveCamera(opts.fov ?? 35, ENV.width / ENV.height, 0.1, 300);
  camera.position.set(0, 2.2, 9);
  camera.lookAt(0, 0.8, 0);
  const key = new T3.DirectionalLight(0xffffff, opts.key ?? 2.4);
  key.position.set(4, 7, 5);
  key.castShadow = opts.shadows !== false;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 5;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 0.5, far: 40 });
  const fill = new T3.HemisphereLight(0xffffff, 0x8a8a8a, opts.fill ?? 0.55);
  const rim = new T3.DirectionalLight(0xffffff, opts.rim ?? 1.3);
  rim.position.set(-5, 4, -6);
  scene.add(key, key.target, fill, rim);
  let ground = null;
  if (opts.ground !== false) {
    ground = new T3.Mesh(new T3.PlaneGeometry(80, 80), new T3.ShadowMaterial({ opacity: opts.shadow ?? 0.2 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = opts.groundY ?? 0;
    ground.receiveShadow = true;
    scene.add(ground);
  }
  const v = new T3.Vector3();
  const stage = {
    THREE: T3, scene, camera, renderer, lights: { key, fill, rim }, ground,
    // add things that cast and catch shadows
    add: (...objs) => { for (const o of objs) { o.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } }); scene.add(o); } return objs[0]; },
    // where a 3D point (or object) is on the frame, in pixels: for 2D labels and marks over the 3D picture
    project: (p) => { if (p.isObject3D) p.getWorldPosition(v); else v.set(p.x, p.y, p.z); v.project(camera); return { x: (v.x + 1) / 2 * ENV.width, y: (1 - v.y) / 2 * ENV.height, behind: v.z > 1 }; },
    render: (ctx) => {
      camera.aspect = ENV.width / ENV.height;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(renderer.domElement, 0, 0, ENV.width, ENV.height);
      ctx.restore();
    },
  };
  stage.parts = (build && build(T3, stage)) || {};
  return stage;
});
const marks = Object.freeze({ stroke: M.stroke, hatch: M.hatch, contour: M.contour, sketchEllipse: M.sketchEllipse, guideLine: M.guideLine, scribbleDot: M.scribbleDot, polyR: M.polyR, ellR: M.ellR, union: M.union, minus: M.minus, inter: M.inter, edgeDist: M.edgeDist, ellipsePts: M.ellipsePts, lengthOf: M.lengthOf, play });
// rigged characters (window.__psRig, rig.js, only on 3D pages that use env.character): built once, posed from t
const character = (name, opts) => memo('character:' + name, () => {
  if (!T3) throw new Error('characters need a 3D stage: call env.stage3d first, then env.character inside its build');
  if (!window.__psRig) throw new Error('the character system is not loaded on this page');
  window.__rigMat = material3d;
  return window.__psRig.build(T3, opts || {});
});
// Lottie motion graphics (window.__psLottie, lottie-mg.js): a scene built once, rendered onto the 2D canvas from t
const motionGraphics = (name, build) => memo('mg:' + name, () => {
  if (!window.__psLottie) throw new Error('motion graphics are not loaded on this page: use env.motionGraphics in the code');
  const scene = new window.__psLottie.Scene({ width: ENV.width, height: ENV.height, fps: ENV.fps, duration: ENV.duration, fonts: ENV.fonts });
  if (build) build(scene);
  const json = scene.toLottie();
  const p = window.__psLottie.player(json);
  return { lottie: json, scene, anim: p.anim, render: (ctx, t) => p.render(ctx, Math.max(0, t)) };
});
// Open Peeps characters (window.__psPeeps, peeps.js): a rigged 2D person built once (named), drawn from t
const peep = (name, opts) => memo('peep:' + name, () => {
  if (!window.__psPeeps) throw new Error('characters are not loaded on this page: use env.peep in the code');
  return window.__psPeeps.Peep({ W: ENV.width, H: ENV.height, duration: ENV.duration, words: ENV.words, palette: ENV.palette }, opts || {});
});
const peeps = Object.freeze({
  get faces() { return window.__psPeeps ? window.__psPeeps.names('face') : []; },
  get hair() { return window.__psPeeps ? window.__psPeeps.names('hair') : []; },
  get standing() { return window.__psPeeps ? window.__psPeeps.names('standing') : []; },
  get sitting() { return window.__psPeeps ? window.__psPeeps.names('sitting') : []; },
  get bust() { return window.__psPeeps ? window.__psPeeps.names('bust') : []; },
});
`

function page(code: string, env: DrawingEnv, fonts: string): string {
  const with3d = uses3d(code)
  const withLottie = usesLottie(code)
  const withPeeps = usesPeeps(code)
  // JSON in a script: "<" escaped so nothing in it can close the tag
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'">
<style>${fonts}
html,body{margin:0;padding:0;overflow:hidden;background:${/^#[0-9a-f]{3,8}$/i.test(env.palette.canvas) ? env.palette.canvas : '#000'}}canvas{display:block}</style></head>
<body><canvas id="c" width="${env.width}" height="${env.height}"></canvas>
<script>${rough()}</script>
<script>${anidoodle()}</script>
${with3d ? `<script>${three()}</script><script>${rigJs()}</script>` : ''}
${withLottie ? lottieJs() : ''}
${withPeeps ? peepsJs() : ''}
<script>
(() => {
  const ENV = ${json(env)};
  ${ENV_HELPERS}
  // no WebGL for a drawing that doesn't use 3D (the browser flag alone doesn't hold in every Chrome build)
  if (!window.THREE) {
    for (const C of [window.HTMLCanvasElement, window.OffscreenCanvas]) {
      if (!C) continue;
      const get = C.prototype.getContext;
      Object.defineProperty(C.prototype, 'getContext', { configurable: false, writable: false, value: function (kind, ...rest) { return /webgl|webgpu|bitmaprenderer/i.test(String(kind)) ? null : get.call(this, kind, ...rest); } });
    }
    try { Object.defineProperty(navigator, 'gpu', { value: undefined }); } catch (e) {}
  }
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
    THREE: T3, stage3d, material3d, character, motionGraphics, peep, peeps,
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
    protocolTimeout: frameTimeout(code) + 4_000,
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
      // 3D drawings: WebGL on the software renderer (no GPU needed, the same frames on every machine); none for the rest
      ...(uses3d(code) ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--disable-3d-apis', '--disable-webgl', '--disable-webgl2']),
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

async function frame(p: Page, t: number, jpeg: boolean, limitMs = FRAME_TIMEOUT_MS): Promise<Buffer | null> {
  let out: string
  try {
    out = (await p.evaluate((tt: number, j: boolean) => (window as unknown as { __frame: (t: number, j: boolean) => string }).__frame(tt, j), t, jpeg)) as string
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new DrawingError(/timed out/i.test(msg) ? `A frame took longer than ${limitMs / 1000} s to draw (an endless loop?)` : msg.slice(0, 300), t)
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
    // (a 3D drawing at a lower rate: each of its frames costs a quarter of a second in software)
    const step = 1 / Math.min(env.fps, uses3d(code) ? 4 : 10)
    const last = Math.max(0, Math.ceil(env.duration / step) - 1)
    const at = (t: number) => Math.min(last, Math.max(0, Math.round(t / step)))
    const want = new Set(times.map(at))
    const shots = new Map<number, Buffer>()
    for (let i = 0; i <= last; i++) {
      if (signal?.aborted) throw new CancelledError()
      const shot = await frame(p, i * step, want.has(i), frameTimeout(code))
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
  const timer = setTimeout(() => void close(browser), uses3d(code) ? RENDER_TIMEOUT_3D_MS : RENDER_TIMEOUT_MS)
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
      const jpg = (await frame(p, i / env.fps, true, frameTimeout(code)))!
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
