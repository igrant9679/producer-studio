// media.sketch: a picture drawn in on screen, stroke by stroke, as a video at the picture's own shape (the editor puts it
// in place of the image clip, Smart tab → Sketch it in). No AI and no model: the picture steers the marks. Its edges
// are traced into contour lines (biggest first), its darks are hatched in two directions, and at the end it can turn
// into the photo in colour. The analysis fields (luminance, edges, the direction texture runs) and the marks
// (pressure-tapered strokes that draw themselves, hatching) are anidoodle's (Apache-2.0, vendor/anidoodle); the
// tracing and the timing are ours. Same idea as Sketch2Motion (photo → line drawing → drawing-on animation), written
// fresh for the drawing sandbox: the code below runs in it as a drawing would (media/drawing.ts).
import sharp from 'sharp'
import type { SketchStyleId, SmartJobResult } from '@producer/core'
import { SKETCH_SECONDS, SKETCH_STYLES } from '@producer/core'
import { HttpError } from '../http'
import type { JobContext } from '../jobs/worker'
import { log } from '../log'
import { DrawingError, type DrawingEnv, renderDrawing } from './drawing'
import { type SmartInput, runSmartTool } from './smartTools'
import path from 'node:path'

/** The paper and ink of each medium (the sandbox fills the frame with the paper before each frame). */
export const SKETCH_MEDIA: Record<SketchStyleId, { paper: string; ink: string }> = {
  pencil: { paper: '#f5f0e4', ink: '#3a3236' },
  ink: { paper: '#fbfaf6', ink: '#16141a' },
  charcoal: { paper: '#eee8da', ink: '#221d1c' },
  chalk: { paper: '#26312e', ink: '#f1eee4' },
}

/** Longest side of the video: a big picture is drawn at 1080p's long side, a small one is drawn larger. */
const LONG_MAX = 1920
const LONG_MIN = 960
/** The picture handed to the sandbox (it analyses a smaller copy; the colour ending shows this one). */
const PICTURE_MAX = 1600

/** The drawing code (the sandbox's contract: function draw(ctx, t, env), a pure function of t). */
export function sketchCode(o: { style: SketchStyleId; colour: boolean }): string {
  return `var OPT = ${JSON.stringify({ style: o.style, colour: o.colour })};
${SKETCH_PROGRAM}`
}

// Plain JS for the page (no template literals inside). Everything slow is built once (env.memo); finished marks are
// kept on a layer and only new ones are added, so a frame costs about the marks being drawn at that moment. The
// layer is rebuilt from nothing whenever time goes backwards, so every frame is the same picture whatever the order.
const SKETCH_PROGRAM = String.raw`
var STYLES = {
  pencil:   { paper: '#f5f0e4', ink: '#3a3236', w: 1.35, a: 0.82, taper: 1,    hw: 1.0, gap: 6.5, tex: 'paper',     texA: 0.32, light: false },
  ink:      { paper: '#fbfaf6', ink: '#16141a', w: 1.5,  a: 0.94, taper: 0.7,  hw: 0.9, gap: 7.5, tex: 'paper',     texA: 0.16, light: false },
  charcoal: { paper: '#eee8da', ink: '#221d1c', w: 3.0,  a: 0.62, taper: 0.55, hw: 2.2, gap: 9,   tex: 'coldpress', texA: 0.42, light: false },
  chalk:    { paper: '#26312e', ink: '#f1eee4', w: 2.2,  a: 0.78, taper: 0.4,  hw: 1.6, gap: 8,   tex: null,        texA: 0,    light: true }
};
var S = STYLES[OPT.style] || STYLES.pencil;

function prefix(list) { var out = new Float64Array(list.length), s = 0; for (var i = 0; i < list.length; i++) { s += list[i].cost; out[i] = s; } return out; }
// how many marks are wholly down when 'target' of the total cost has been drawn
function done(cum, target) { var lo = 0, hi = cum.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (cum[mid] <= target) lo = mid + 1; else hi = mid; } return lo; }

function build(env) {
  var A = env.lib, W = env.W, H = env.H;
  var img = env.image('picture');
  if (!img) throw new Error('the picture did not load');
  var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  var k0 = Math.min(1, 420 / Math.max(iw, ih));
  var aw = Math.max(8, Math.round(iw * k0)), ah = Math.max(8, Math.round(ih * k0));
  var small = env.surface(aw, ah);
  small.ctx.imageSmoothingQuality = 'high';
  small.ctx.drawImage(img, 0, 0, aw, ah);
  var F = A.photo.photoFields({ W: aw, H: ah, scale: 1, canvas: env.surface, cache: new Map(), image: function () { return small.canvas; } }, 'picture', { tensorR: 3 });
  var s = Math.min(W / aw, H / ah), ox = (W - aw * s) / 2, oy = (H - ah * s) / 2;
  var lw = Math.max(0.8, Math.min(W, H) / 720);
  var at = function (x, y) { return [ox + x * s, oy + y * s]; };
  var edge = F.edge, lum = F.lum;
  var sorted = Float32Array.from(edge).sort();
  var thr = Math.max(0.01, sorted[Math.floor(sorted.length * 0.82)] || 0);
  // tone against the picture's own range, so a light or a dark photo still gets its shading
  var ls = Float32Array.from(lum).sort(), lo = ls[Math.floor(ls.length * 0.04)], hi = ls[Math.floor(ls.length * 0.96)], span = Math.max(0.08, hi - lo);

  // ---- contours: walk along each strong edge, the way the texture runs, nudged onto the ridge
  var occ = new Uint8Array(aw * ah);
  var E = function (x, y) { var xi = Math.round(x), yi = Math.round(y); return xi < 1 || yi < 1 || xi >= aw - 1 || yi >= ah - 1 ? 0 : edge[yi * aw + xi]; };
  var free = function (x, y) { var xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < aw && yi < ah && !occ[yi * aw + xi]; };
  var take = function (x, y) { var xi = Math.round(x), yi = Math.round(y); for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { var X = xi + dx, Y = yi + dy; if (X >= 0 && Y >= 0 && X < aw && Y < ah) occ[Y * aw + X] = 1; } };
  var flow = function (x, y) { var i = Math.round(y) * aw + Math.round(x), a = F.J11[i], b = F.J12[i], c = F.J22[i], th = 0.5 * Math.atan2(2 * b, a - c) + Math.PI / 2; return [Math.cos(th), Math.sin(th)]; };
  var walk = function (x, y, sign) {
    var pts = [], d = flow(x, y);
    d = [d[0] * sign, d[1] * sign];
    for (var n = 0; n < 240; n++) {
      var f = flow(x, y);
      if (f[0] * d[0] + f[1] * d[1] < 0) f = [-f[0], -f[1]];
      d = [d[0] * 0.55 + f[0] * 0.45, d[1] * 0.55 + f[1] * 0.45];
      var L = Math.hypot(d[0], d[1]) || 1;
      d = [d[0] / L, d[1] / L];
      var nx = x + d[0], ny = y + d[1], px = -d[1], py = d[0];
      var e0 = E(nx, ny), e1 = E(nx + px * 0.8, ny + py * 0.8), e2 = E(nx - px * 0.8, ny - py * 0.8);
      if (e1 > e0 && e1 >= e2) { nx += px * 0.5; ny += py * 0.5; } else if (e2 > e0) { nx -= px * 0.5; ny -= py * 0.5; }
      if (E(nx, ny) < thr * 0.4 || !free(nx, ny)) break;
      x = nx; y = ny;
      pts.push([x, y]);
    }
    return pts;
  };
  var seeds = [];
  for (var y = 2; y < ah - 2; y += 2) for (var x = 2; x < aw - 2; x += 2) { var e = edge[y * aw + x]; if (e > thr) seeds.push([e, x, y]); }
  seeds.sort(function (p, q) { return q[0] - p[0]; });
  var lines = [];
  for (var i = 0; i < seeds.length && lines.length < 1800; i++) {
    var sx = seeds[i][1], sy = seeds[i][2];
    if (!free(sx, sy)) continue;
    var pts = walk(sx, sy, -1).reverse().concat([[sx, sy]], walk(sx, sy, 1));
    for (var j = 0; j < pts.length; j++) take(pts[j][0], pts[j][1]);
    if (pts.length < 5) continue;
    var sum = 0;
    for (j = 0; j < pts.length; j++) sum += E(pts[j][0], pts[j][1]);
    lines.push({ pts: pts, weight: pts.length * (sum / pts.length) });
  }
  lines.sort(function (p, q) { return q.weight - p.weight; });
  var top = lines.length ? lines[0].weight : 1;
  var contours = lines.map(function (l) {
    var pts = l.pts.filter(function (_, q) { return q % 2 === 0 || q === l.pts.length - 1; }).map(function (p) { return at(p[0], p[1]); });
    var k = Math.min(1, 0.35 + (2 * l.weight) / top);
    return A.marks.stroke(pts, { w: S.w * lw * (0.75 + 0.4 * k), col: S.ink, a: S.a * (0.55 + 0.45 * k), taper: S.taper });
  });

  // ---- tone: hatching where the medium covers (the darks; for chalk, the lights), a second direction for the deepest
  var tone = function (fx, fy) {
    var u = (fx - ox) / s, v = (fy - oy) / s;
    if (u < 0 || v < 0 || u > aw - 1 || v > ah - 1) return 0;
    var l = Math.min(1, Math.max(0, (lum[Math.round(v) * aw + Math.round(u)] - lo) / span));
    return S.light ? l : 1 - l;
  };
  var box = [ox, oy, ox + aw * s, oy + ah * s];
  var reg = { box: box, has: function (fx, fy) { return fx >= box[0] && fx <= box[2] && fy >= box[1] && fy <= box[3]; } };
  var g = S.gap * lw;
  var h1 = A.marks.hatch(reg, { ang: -0.95, gap: g, len: 26 * lw, w: S.hw * lw, col: S.ink, a: S.a * 0.7, seed: 11, taper: S.taper, dens: function (fx, fy) { return Math.pow(Math.max(0, (tone(fx, fy) - 0.32) / 0.55), 1.1); } });
  var h2 = A.marks.hatch(reg, { ang: 0.62, gap: g * 1.1, len: 22 * lw, w: S.hw * lw, col: S.ink, a: S.a * 0.6, seed: 23, taper: S.taper, dens: function (fx, fy) { return Math.max(0, (tone(fx, fy) - 0.6) / 0.32); } });
  var hatch = h1.concat(h2);

  var D = env.duration, t0 = Math.min(0.3, D * 0.05);
  var drawEnd = D * (OPT.colour ? 0.68 : 0.86);
  var cEnd = t0 + (drawEnd - t0) * 0.58, hStart = cEnd - (cEnd - t0) * 0.15;
  return { img: img, box: box, contours: contours, hatch: hatch, cCum: prefix(contours), hCum: prefix(hatch), t0: t0, cEnd: cEnd, hStart: hStart, drawEnd: drawEnd, layer: env.surface(W, H), nC: 0, nH: 0 };
}

function draw(ctx, t, env) {
  var B = env.memo('sketch', function () { return build(env); });
  var W = env.W, H = env.H;
  ctx.fillStyle = S.paper;
  ctx.fillRect(0, 0, W, H);
  // the picture in colour comes up under the lines at the end (when asked for)
  var cK = OPT.colour ? env.ease.inOut(env.clamp((t - B.drawEnd) / Math.max(0.3, env.duration * 0.16))) : 0;
  if (cK > 0) { ctx.globalAlpha = cK; ctx.drawImage(B.img, B.box[0], B.box[1], B.box[2] - B.box[0], B.box[3] - B.box[1]); ctx.globalAlpha = 1; }
  var cT = B.cCum.length ? B.cCum[B.cCum.length - 1] : 0, hT = B.hCum.length ? B.hCum[B.hCum.length - 1] : 0;
  var cAt = env.clamp((t - B.t0) / Math.max(1e-6, B.cEnd - B.t0)) * cT;
  var hAt = env.clamp((t - B.hStart) / Math.max(1e-6, B.drawEnd - B.hStart)) * hT;
  var nC = done(B.cCum, cAt), nH = done(B.hCum, hAt);
  // finished marks live on the layer (one ink colour, so the order they went down in doesn't change the pixels)
  var L = B.layer.ctx;
  if (nC < B.nC || nH < B.nH) { L.setTransform(1, 0, 0, 1, 0, 0); L.clearRect(0, 0, W, H); B.nC = 0; B.nH = 0; }
  for (var i = B.nC; i < nC; i++) B.contours[i].draw(L, 1);
  for (i = B.nH; i < nH; i++) B.hatch[i].draw(L, 1);
  B.nC = nC; B.nH = nH;
  ctx.globalAlpha = 1 - 0.5 * cK;
  ctx.drawImage(B.layer.canvas, 0, 0);
  ctx.globalAlpha = 1;
  // the marks being drawn right now, as far as the pencil has got
  if (nC < B.contours.length && cAt > 0) B.contours[nC].draw(ctx, (cAt - (nC ? B.cCum[nC - 1] : 0)) / B.contours[nC].cost);
  if (nH < B.hatch.length && hAt > 0) B.hatch[nH].draw(ctx, (hAt - (nH ? B.hCum[nH - 1] : 0)) / B.hatch[nH].cost);
  if (S.tex) env.doodle(ctx, t).paper(S.tex, S.texA);
}
`

/** The video's frame at the picture's shape: the long side within LONG_MIN..LONG_MAX, both sides even. */
export function sketchFrame(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height)
  const k = Math.min(LONG_MAX, Math.max(LONG_MIN, long)) / long
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2)
  return { width: even(width), height: even(height) }
}

/** The job: sketch a picture in, saved as a clip next to it (the editor swaps it into the image clip). */
export async function sketchPicture(jc: JobContext): Promise<SmartJobResult> {
  const input = jc.job.input as unknown as SmartInput
  const style: SketchStyleId = SKETCH_STYLES.some((s) => s.id === input.style) ? (input.style as SketchStyleId) : 'pencil'
  const colour = input.colour !== false
  const seconds = Math.min(SKETCH_SECONDS.max, Math.max(SKETCH_SECONDS.min, Number.isFinite(input.seconds) ? Number(input.seconds) : SKETCH_SECONDS.default))
  return runSmartTool(
    'sketch',
    jc,
    async ({ row, src, work, progress }) => {
      if (row.kind !== 'image') throw new HttpError(400, 'invalid', 'Sketch it in works on pictures')
      progress(0.02, 'Reading the picture')
      // upright, flattened onto white (a transparent picture's empty parts read as paper, not black), at most PICTURE_MAX
      const picture = await sharp(src, { limitInputPixels: 80_000_000 })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({ width: PICTURE_MAX, height: PICTURE_MAX, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer({ resolveWithObject: true })
      const frame = sketchFrame(picture.info.width, picture.info.height)
      const media = SKETCH_MEDIA[style]
      const env: DrawingEnv = {
        ...frame,
        duration: seconds,
        fps: 30,
        words: [],
        palette: { canvas: media.paper, ink: media.ink, accent: media.ink },
        fonts: { headline: 'Inter', body: 'Inter' },
        images: { picture: `data:image/jpeg;base64,${picture.data.toString('base64')}` },
      }
      const out = path.join(work, 'sketch.mp4')
      progress(0.05, 'Sketching it in')
      try {
        await renderDrawing(sketchCode({ style, colour }), env, out, { signal: jc.signal, onProgress: (f) => progress(0.05 + f * 0.95, 'Sketching it in') })
      } catch (err) {
        if (!(err instanceof DrawingError)) throw err
        log.warn('sketch failed', { error: err.message, at: err.at })
        throw new HttpError(502, 'server', `The picture couldn’t be sketched (${err.message.slice(0, 120)})`)
      }
      return { file: out, mime: 'video/mp4', kind: 'video', offset: 0 }
    },
    { style, colour, seconds },
  )
}
