// Pixel grades on the page (curves, HSL, LUT: colour.ts). One WebGL context per renderer runs a clip's grade stages
// over its current frame, and the result is copied into a canvas laid over the clip (a page may hold only a few
// WebGL contexts, a clip has a plain 2D canvas). Without WebGL the same maths runs on the CPU. The export bundles
// this file with the renderer, so headless Chrome draws the grade exactly as the preview does.
import { HSL_HUE_DEG, gradePixels, prepareGrade, type PreparedGrade } from './colour'
import { evaluate } from './evaluate'
import type { FrameLayer, Project } from './types'
import { safeColor } from './util'

type Stage = { grade: PreparedGrade; mix: number }
type Source = HTMLVideoElement | HTMLImageElement

const VS = `attribute vec2 p;
varying vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`

// the shader is colour.ts's gradePixel, line for line
const FS = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 uv;
uniform sampler2D u_src;
uniform sampler2D u_curves;
uniform sampler2D u_lut;
uniform float u_useCurves;
uniform float u_useHsl;
uniform float u_lutN;
uniform float u_lutMix;
uniform float u_mix;
uniform vec3 u_hsl[9];
uniform float u_hue[9];

vec3 rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < 1e-6) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h * 60.0, s, l);
}
float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(float h, float s, float l) {
  if (s < 1e-6) return vec3(l);
  float hh = mod(mod(h, 360.0) + 360.0, 360.0) / 360.0;
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(hue2rgb(p, q, hh + 1.0 / 3.0), hue2rgb(p, q, hh), hue2rgb(p, q, hh - 1.0 / 3.0));
}
vec3 applyHsl(vec3 c) {
  vec3 hsl = rgb2hsl(c);
  float k = min(1.0, (max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b)) * 5.0);
  if (k <= 0.0) return c;
  vec3 sh = u_hsl[0];
  for (int i = 0; i < 8; i++) {
    if (hsl.x >= u_hue[i] && hsl.x < u_hue[i + 1]) sh = mix(u_hsl[i], u_hsl[i + 1], (hsl.x - u_hue[i]) / (u_hue[i + 1] - u_hue[i]));
  }
  sh = sh / 100.0 * k;
  float s2 = clamp(hsl.y * (1.0 + sh.y), 0.0, 1.0);
  float l2 = clamp(sh.z >= 0.0 ? hsl.z + (1.0 - hsl.z) * sh.z * 0.6 : hsl.z * (1.0 + sh.z * 0.6), 0.0, 1.0);
  return hsl2rgb(hsl.x + sh.x * ${HSL_HUE_DEG.toFixed(1)}, s2, l2);
}
vec3 lutAt(float r, float g, float b) {
  return texture2D(u_lut, vec2((r + b * u_lutN + 0.5) / (u_lutN * u_lutN), (g + 0.5) / u_lutN)).rgb;
}
vec3 lutSample(vec3 c) {
  float m = u_lutN - 1.0;
  vec3 f = clamp(c, 0.0, 1.0) * m;
  vec3 i0 = floor(f);
  vec3 i1 = min(i0 + 1.0, m);
  vec3 t = f - i0;
  vec3 c00 = mix(lutAt(i0.r, i0.g, i0.b), lutAt(i1.r, i0.g, i0.b), t.r);
  vec3 c10 = mix(lutAt(i0.r, i1.g, i0.b), lutAt(i1.r, i1.g, i0.b), t.r);
  vec3 c01 = mix(lutAt(i0.r, i0.g, i1.b), lutAt(i1.r, i0.g, i1.b), t.r);
  vec3 c11 = mix(lutAt(i0.r, i1.g, i1.b), lutAt(i1.r, i1.g, i1.b), t.r);
  return mix(mix(c00, c10, t.g), mix(c01, c11, t.g), t.b);
}
void main() {
  vec4 src = texture2D(u_src, uv);
  vec3 c = src.rgb;
  if (u_useCurves > 0.5) {
    c = vec3(
      texture2D(u_curves, vec2((c.r * 255.0 + 0.5) / 256.0, 0.5)).r,
      texture2D(u_curves, vec2((c.g * 255.0 + 0.5) / 256.0, 0.5)).g,
      texture2D(u_curves, vec2((c.b * 255.0 + 0.5) / 256.0, 0.5)).b);
  }
  if (u_useHsl > 0.5) c = applyHsl(c);
  if (u_lutN > 1.5) c = mix(c, lutSample(c), u_lutMix);
  gl_FragColor = vec4(mix(src.rgb, c, u_mix), src.a);
}`

const HUES = [0, 30, 60, 120, 180, 240, 270, 300, 360]

/** One WebGL context that grades a frame into its own canvas, stage by stage. */
class GradeGL {
  readonly canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext
  private prog: WebGLProgram
  private loc: Record<string, WebGLUniformLocation | null> = {}
  private src: WebGLTexture
  private dummy: WebGLTexture
  private ping: Array<{ tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }> = []
  private curves = new Map<string, WebGLTexture>()
  private luts = new Map<string, WebGLTexture>()
  lost = false
  readonly maxSize: number

  static create(): GradeGL | null {
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false, alpha: true }) as WebGLRenderingContext | null
      return gl ? new GradeGL(canvas, gl) : null
    } catch {
      return null
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGLRenderingContext) {
    this.canvas = canvas
    this.gl = gl
    canvas.addEventListener('webglcontextlost', () => (this.lost = true))
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'program')
    this.prog = prog
    gl.useProgram(prog)
    for (const n of ['u_src', 'u_curves', 'u_lut', 'u_useCurves', 'u_useHsl', 'u_lutN', 'u_lutMix', 'u_mix', 'u_hsl', 'u_hue']) this.loc[n] = gl.getUniformLocation(prog, n)
    gl.uniform1i(this.loc.u_src, 0)
    gl.uniform1i(this.loc.u_curves, 1)
    gl.uniform1i(this.loc.u_lut, 2)
    gl.uniform1fv(this.loc.u_hue, new Float32Array(HUES))
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const at = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(at)
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0)
    this.maxSize = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number)
    this.src = this.texture(gl.NEAREST)
    this.dummy = this.texture(gl.NEAREST)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
  }

  private texture(filter: number): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  private curveTex(g: PreparedGrade): WebGLTexture {
    let t = this.curves.get(g.key)
    if (t) return t
    const gl = this.gl
    t = this.texture(gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, g.curves!)
    if (this.curves.size > 32) this.clear(this.curves)
    this.curves.set(g.key, t)
    return t
  }

  private lutTex(g: PreparedGrade): WebGLTexture {
    const lut = g.lut!
    const key = `${lut.id}:${lut.size}`
    let t = this.luts.get(key)
    if (t) return t
    const gl = this.gl
    const n = lut.size
    // an n² × n atlas: blue slices side by side, red across each, green down
    const atlas = new Uint8Array(n * n * n * 4)
    for (let b = 0; b < n; b++)
      for (let g1 = 0; g1 < n; g1++)
        for (let r = 0; r < n; r++) {
          const s = ((b * n + g1) * n + r) * 3
          const o = (g1 * n * n + b * n + r) * 4
          atlas[o] = lut.data[s]
          atlas[o + 1] = lut.data[s + 1]
          atlas[o + 2] = lut.data[s + 2]
          atlas[o + 3] = 255
        }
    t = this.texture(gl.NEAREST)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n * n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas)
    if (this.luts.size > 8) this.clear(this.luts)
    this.luts.set(key, t)
    return t
  }

  private clear(m: Map<string, WebGLTexture>) {
    for (const t of m.values()) this.gl.deleteTexture(t)
    m.clear()
  }

  private target(i: number, w: number, h: number) {
    const gl = this.gl
    let p = this.ping[i]
    if (!p) {
      const tex = this.texture(gl.NEAREST)
      p = { tex, fb: gl.createFramebuffer()!, w: 0, h: 0 }
      this.ping[i] = p
    }
    if (p.w !== w || p.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, p.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, p.fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, p.tex, 0)
      p.w = w
      p.h = h
    }
    return p
  }

  /** Grade `source` (drawn at w × h) through the stages into this.canvas. Throws on a cross-origin source. */
  run(source: Source, w: number, h: number, stages: Stage[]) {
    const gl = this.gl
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.src)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    // a source larger than the canvas is sampled at the canvas's pixels
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    let input = this.src
    stages.forEach((s, i) => {
      const last = i === stages.length - 1
      const out = last ? null : this.target(i % 2, w, h)
      gl.bindFramebuffer(gl.FRAMEBUFFER, out?.fb ?? null)
      gl.viewport(0, 0, w, h)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, input)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, s.grade.curves ? this.curveTex(s.grade) : this.dummy)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, s.grade.lut && s.grade.lutMix > 0 ? this.lutTex(s.grade) : this.dummy)
      gl.uniform1f(this.loc.u_useCurves, s.grade.curves ? 1 : 0)
      gl.uniform1f(this.loc.u_useHsl, s.grade.hsl ? 1 : 0)
      if (s.grade.hsl) {
        const v = new Float32Array(27)
        v.set(s.grade.hsl)
        v.set(s.grade.hsl.subarray(0, 3), 24)
        gl.uniform3fv(this.loc.u_hsl, v)
      }
      gl.uniform1f(this.loc.u_lutN, s.grade.lut && s.grade.lutMix > 0 ? s.grade.lut.size : 0)
      gl.uniform1f(this.loc.u_lutMix, s.grade.lutMix)
      gl.uniform1f(this.loc.u_mix, s.mix)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      if (out) input = out.tex
    })
  }
}

interface Surface {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D | null
  wrap: HTMLElement
  content: HTMLElement
  layer?: FrameLayer
  still?: HTMLImageElement
  stages: Stage[]
  /** What was last drawn, so a still frame isn't graded again. */
  drawn?: string
  /** Preview: the media can't be read (cross-origin without CORS); shown ungraded. */
  blocked?: boolean
  retried?: boolean
  listening?: HTMLElement
}

/** Media style used for the grade canvas: it sits exactly where the picture does (crop included). */
export class GradeLayers {
  private surfaces = new Map<string, Surface>()
  private gl?: GradeGL | null
  private readonly onLoad: (e: Event) => void

  constructor(
    private root: HTMLElement,
    private mode: 'preview' | 'export',
    private project: () => Project,
  ) {
    // export: HyperFrames puts each video frame into the page as an <img> beside its <video> after the timeline has
    // been seeked, then takes the screenshot: grade again when it arrives (a capture listener sees every load)
    this.onLoad = (e) => {
      const id = (e.target as HTMLElement | null)?.closest?.('[data-ps-layer]')?.getAttribute('data-ps-layer')
      const s = id ? this.surfaces.get(id) : undefined
      if (s) this.draw(s, true)
    }
    root.addEventListener('load', this.onLoad, true)
  }

  /** A layer's grade canvas when it shows one (for the scopes). */
  canvasOf(id: string): HTMLCanvasElement | undefined {
    const s = this.surfaces.get(id)
    return s && s.layer && !s.blocked && s.canvas.style.display !== 'none' ? s.canvas : undefined
  }

  /**
   * Called for every drawn video or image layer: grade it (over `content`, styled `fill`), or put the plain picture
   * back. `still` is the frame an export shows before the clip's file starts, when it is showing.
   */
  update(id: string, wrap: HTMLElement, content: HTMLElement, layer: FrameLayer, fill: string, still?: HTMLImageElement) {
    let s = this.surfaces.get(id)
    const grades = layer.grades?.filter((g) => g.mix > 0.001) ?? []
    if (!grades.length) {
      if (s) this.hide(s)
      return
    }
    const p = this.project()
    const stages = grades.map((g) => ({ grade: prepareGrade(g.grade, p.luts), mix: g.mix })).filter((x) => x.grade.curves || x.grade.hsl || (x.grade.lut && x.grade.lutMix > 0))
    if (!stages.length) {
      if (s) this.hide(s)
      return
    }
    if (!s) {
      const canvas = document.createElement('canvas')
      canvas.dataset.psGrade = '1'
      s = { canvas, ctx: null, wrap, content, stages }
      this.surfaces.set(id, s)
    }
    s.content = content
    if (s.canvas.parentElement !== wrap) wrap.insertBefore(s.canvas, wrap.querySelector('[data-ps-overlay]'))
    const css = `${fill};pointer-events:none`
    if (s.canvas.style.cssText !== css) s.canvas.style.cssText = css
    s.layer = layer
    s.still = still
    s.stages = stages
    this.listen(s)
    if (s.blocked) return this.hide(s, true)
    this.draw(s, false)
  }

  private listen(s: Surface) {
    if (s.listening === s.content) return
    s.listening = s.content
    // a seek or a load finishes after the frame was asked for: grade the frame that arrived
    for (const ev of ['seeked', 'loadeddata', 'load']) s.content.addEventListener(ev, () => this.surfaces.get(s.layer?.itemId ?? '') === s && this.draw(s, true))
  }

  private hide(s: Surface, keepLayer = false) {
    s.canvas.style.display = 'none'
    s.content.style.opacity = ''
    if (s.still) s.still.style.opacity = ''
    if (!keepLayer) s.layer = undefined
    s.drawn = undefined
  }

  /** The element whose picture shows now. */
  private source(s: Surface): Source | undefined {
    if (s.still && s.still.complete && s.still.naturalWidth) return s.still
    const c = s.content
    if (c instanceof HTMLVideoElement) {
      if (this.mode === 'export') {
        // the frame HyperFrames injected for this video, while it shows
        const f = s.wrap.querySelector('img.__render_frame__') as HTMLImageElement | null
        if (f && f.complete && f.naturalWidth && f.style.visibility !== 'hidden') return f
      }
      return c.readyState >= 2 && c.videoWidth ? c : undefined
    }
    if (c instanceof HTMLImageElement) return c.complete && c.naturalWidth ? c : undefined
    return undefined
  }

  private draw(s: Surface, force: boolean) {
    if (!s.layer || s.blocked) return
    const src = this.source(s)
    if (!src) return
    const nw = src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth
    const nh = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight
    const gl = this.glContext()
    const cap = gl?.maxSize ?? 2048
    const k = Math.min(1, cap / Math.max(nw, nh))
    const w = Math.max(1, Math.round(nw * k))
    const h = Math.max(1, Math.round(nh * k))
    const key = `${src instanceof HTMLVideoElement ? `v${src.currentTime}` : src.currentSrc || src.src}|${w}x${h}|${s.stages.map((x) => `${x.grade.key}@${x.mix.toFixed(4)}`).join(',')}`
    const moving = src instanceof HTMLVideoElement && !src.paused
    if (!force && !moving && key === s.drawn) return this.show(s)
    try {
      if (s.canvas.width !== w || s.canvas.height !== h) {
        s.canvas.width = w
        s.canvas.height = h
      }
      s.ctx ??= s.canvas.getContext('2d')
      if (!s.ctx) return
      if (gl) {
        gl.run(src, w, h, s.stages)
        s.ctx.clearRect(0, 0, w, h)
        s.ctx.drawImage(gl.canvas, 0, 0)
      } else {
        s.ctx.clearRect(0, 0, w, h)
        s.ctx.drawImage(src, 0, 0, w, h)
        const img = s.ctx.getImageData(0, 0, w, h)
        gradePixels(img.data, s.stages)
        s.ctx.putImageData(img, 0, 0)
      }
      s.drawn = key
      this.show(s)
    } catch (e) {
      if ((e as { name?: string })?.name === 'SecurityError') return this.unreadable(s)
      // a GPU that fails mid-draw: the CPU draws it from the next frame on
      if (gl) this.gl = null
      this.hide(s, true)
    }
  }

  private show(s: Surface) {
    s.canvas.style.display = 'block'
    s.content.style.opacity = '0'
    if (s.still) s.still.style.opacity = '0'
  }

  /**
   * Preview: the media's pixels can't be read (served from another origin). Ask for it with CORS once; if the
   * host doesn't allow that either, show the clip ungraded (the export, which reads local files, still grades it).
   */
  private unreadable(s: Surface) {
    const m = s.content as HTMLMediaElement | HTMLImageElement
    if (this.mode === 'preview' && !s.retried && 'crossOrigin' in m && !m.crossOrigin) {
      s.retried = true
      const src = m.getAttribute('src')
      const t = m instanceof HTMLMediaElement ? m.currentTime : 0
      m.addEventListener(
        'error',
        () => {
          s.blocked = true
          m.removeAttribute('crossorigin')
          if (src) m.setAttribute('src', src)
          if (m instanceof HTMLMediaElement) m.currentTime = t
          s.wrap.dataset.psGradeBlocked = '1'
          this.hide(s, true)
        },
        { once: true },
      )
      m.crossOrigin = 'anonymous'
      if (src) m.setAttribute('src', src)
      if (m instanceof HTMLMediaElement) m.currentTime = t
      this.hide(s, true)
      return
    }
    s.blocked = true
    s.wrap.dataset.psGradeBlocked = '1'
    this.hide(s, true)
  }

  private glContext(): GradeGL | null {
    if (this.gl?.lost) this.gl = undefined
    if (this.gl === undefined) {
      try {
        this.gl = typeof document !== 'undefined' ? GradeGL.create() : null
      } catch {
        this.gl = null
      }
    }
    return this.gl
  }

  remove(id: string) {
    const s = this.surfaces.get(id)
    if (!s) return
    s.canvas.remove()
    this.surfaces.delete(id)
  }

  destroy() {
    this.root.removeEventListener('load', this.onLoad, true)
    for (const id of [...this.surfaces.keys()]) this.remove(id)
  }
}

/** The renderers on the page by their root element, for the scopes. */
export const STAGES = new WeakMap<HTMLElement, { snapshot(maxWidth?: number): ImageData | null }>()

const COMPOSITE: Record<string, GlobalCompositeOperation> = { normal: 'source-over' }

/**
 * The picture at time t as the preview draws it, small: every clip and image (graded, with its filter, opacity and
 * blend) and every adjustment layer's filter, in order. Text and shapes are left out. Null when a picture can't be
 * read (media from another origin without CORS).
 */
export function snapshotFrame(p: Project, t: number, mediaOf: (id: string) => HTMLElement | undefined, grades: GradeLayers, maxWidth = 320): ImageData | null {
  if (typeof document === 'undefined') return null
  const k = Math.min(1, maxWidth / p.width)
  const W = Math.max(1, Math.round(p.width * k))
  const H = Math.max(1, Math.round(p.height * k))
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.fillStyle = safeColor(p.background, '#000000')
  ctx.fillRect(0, 0, W, H)
  const frame = evaluate(p, t)
  for (const l of [...frame.layers].sort((a, b) => a.z - b.z)) {
    if (l.type === 'adjustment') {
      if (!l.backdrop) continue
      const copy = document.createElement('canvas')
      copy.width = W
      copy.height = H
      copy.getContext('2d')?.drawImage(c, 0, 0)
      ctx.save()
      ctx.globalAlpha = l.opacity
      ctx.filter = l.backdrop
      ctx.drawImage(copy, 0, 0)
      ctx.restore()
      continue
    }
    if (l.type !== 'video' && l.type !== 'image') continue
    const media = mediaOf(l.itemId)
    const graded = grades.canvasOf(l.itemId)
    const src: CanvasImageSource | undefined = graded ?? (media instanceof HTMLVideoElement ? (media.readyState >= 2 ? media : undefined) : media instanceof HTMLImageElement && media.complete ? media : undefined)
    if (!src) continue
    const sw = src instanceof HTMLVideoElement ? src.videoWidth : (src as HTMLCanvasElement | HTMLImageElement).width
    const sh = src instanceof HTMLVideoElement ? src.videoHeight : (src as HTMLCanvasElement | HTMLImageElement).height
    if (!sw || !sh) continue
    const cr = l.crop ?? { left: 0, top: 0, right: 0, bottom: 0 }
    const rot = Number(/rotate\((-?[\d.]+)deg\)/.exec(l.transform)?.[1] ?? 0)
    const sc = /scale\((-?[\d.]+),\s*(-?[\d.]+)\)/.exec(l.transform)
    ctx.save()
    ctx.globalAlpha = l.opacity
    ctx.globalCompositeOperation = COMPOSITE[l.blend] ?? (l.blend as GlobalCompositeOperation)
    if (l.filter) ctx.filter = l.filter
    ctx.translate(l.box.cx * k, l.box.cy * k)
    ctx.rotate((rot * Math.PI) / 180)
    ctx.scale(Number(sc?.[1] ?? 1), Number(sc?.[2] ?? 1))
    const bw = l.box.width * k
    const bh = l.box.height * k
    ctx.drawImage(src, cr.left * sw, cr.top * sh, Math.max(1, (1 - cr.left - cr.right) * sw), Math.max(1, (1 - cr.top - cr.bottom) * sh), -bw / 2, -bh / 2, bw, bh)
    ctx.restore()
  }
  try {
    return ctx.getImageData(0, 0, W, H)
  } catch {
    return null
  }
}
