// Background music composed for a video from its scene cuts: the music half of huashu-motion's cli/lib/sound.js
// (MIT, see LICENSE), without the browser that read a film's page, the sample pack, the written-score mode and the
// sound effects (Producer places its own). What is kept is that file's mixdown for the music bus, unchanged in what it
// does: score.js composes the arrangement (style, sections on the cuts, the drop, the ending), the buses are summed in
// one room, the build opens up before a drop, the fader rides the sections' energy, the low end is balanced, and the
// whole is levelled to a loudness target and limited. Plain JS, no dependencies; the same input gives the same file.
// @ts-nocheck
import { N, RATE, biquad, db, reverb, rng, undb } from './dsp.js';
import { STYLES, PRODUCTS, describe, master, plan, pump, renderScore, resetVoices } from './score.js';

export { STYLES, PRODUCTS, RATE };

class Track {
  constructor(sec) { this.n = N(sec); this.L = new Float32Array(this.n); this.R = new Float32Array(this.n); }
  // equal-power pan; pan ±1 sends the signal to one side only
  add(sig, at, gain = 1, pan = 0) {
    const a = (Math.max(-1, Math.min(1, pan)) + 1) * Math.PI / 4, gl = Math.cos(a) * gain * Math.SQRT2, gr = Math.sin(a) * gain * Math.SQRT2;
    const hard = Math.abs(pan) >= 1;
    let o = Math.round(at * RATE), i0 = 0;
    if (o < 0) { i0 = -o; o = 0; }
    for (let i = i0, j = o; i < sig.length && j < this.n; i++, j++) {
      if (hard) { if (pan < 0) this.L[j] += sig[i] * gain; else this.R[j] += sig[i] * gain; }
      else { this.L[j] += sig[i] * gl; this.R[j] += sig[i] * gr; }
    }
  }
  scale(g) { for (let i = 0; i < this.n; i++) { this.L[i] *= g; this.R[i] *= g; } return this; }
}

// Integrated loudness, ITU-R BS.1770-4 (K-weighting, 400 ms blocks, 75 % overlap, both gates). 48 kHz.
export function loudness(L, R) {
  const kw = (x) => {
    const st = (x, b, a) => { const o = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const y = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = y; o[i] = y; } return o; };
    return st(st(x, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]), [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
  };
  const chans = [kw(L), ...(R ? [kw(R)] : [])];
  const size = Math.round(0.4 * RATE), hop = Math.round(0.1 * RATE), blocks = [];
  for (let s = 0; s + size <= chans[0].length; s += hop) {
    let z = 0;
    for (const c of chans) { let acc = 0; for (let i = s; i < s + size; i++) acc += c[i] * c[i]; z += acc / size; }
    blocks.push(z);
  }
  const lk = (z) => -0.691 + 10 * Math.log10(Math.max(z, 1e-12));
  const abs = blocks.filter((z) => lk(z) > -70);
  if (!abs.length) return -Infinity;
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => lk(z) > rel);
  return lk(gated.reduce((a, b) => a + b, 0) / gated.length);
}

// Look-ahead peak limiter: the gain falls before a peak arrives and recovers over ~80 ms.
function limit(t, ceiling) {
  const la = N(0.004), rel = Math.exp(-1 / (0.08 * RATE)), n = t.n;
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = Math.max(Math.abs(t.L[i]), Math.abs(t.R[i])); need[i] = p > ceiling ? ceiling / p : 1; }
  const minAhead = new Float32Array(n), dq = [];
  for (let i = n - 1; i >= 0; i--) { // min over [i, i + la]
    while (dq.length && need[dq[dq.length - 1]] >= need[i]) dq.pop();
    dq.push(i);
    while (dq[0] > i + la) dq.shift();
    minAhead[i] = need[dq[0]];
  }
  let g = 1;
  for (let i = 0; i < n; i++) { g = Math.min(minAhead[i], 1 - (1 - g) * rel); t.L[i] *= g; t.R[i] *= g; }
  return t;
}

// Feed-forward RMS compressor, threshold relative to the track's own peak (dB below it), soft knee-free.
function compress(t, below, ratio, att = 0.008, rel = 0.15) {
  const thr = db(peakOf(t)) + below, a = Math.exp(-1 / (att * RATE)), r = Math.exp(-1 / (rel * RATE));
  let env2 = 0, g = 1;
  for (let i = 0; i < t.n; i++) {
    const x = Math.max(Math.abs(t.L[i]), Math.abs(t.R[i])) ** 2;
    env2 = x > env2 ? x + (env2 - x) * a : x + (env2 - x) * r;
    const lvl = 10 * Math.log10(env2 + 1e-12), over = lvl - thr;
    const target = over > 0 ? undb(-over * (1 - 1 / ratio)) : 1;
    g = target < g ? target + (g - target) * a : target + (g - target) * r;
    t.L[i] *= g; t.R[i] *= g;
  }
}
// Low-end balance: if the band under 120 Hz sits above 400 Hz–2 kHz (where laptops and
// phones actually play), shelve it down by the excess (up to 8 dB).
function balanceLows(t, over = 0) {
  const n = t.n, mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (t.L[i] + t.R[i]) / 2;
  const rms = (x) => { let a = 0; for (let i = 0; i < x.length; i++) a += x[i] * x[i]; return Math.sqrt(a / x.length); };
  const excess = db(rms(biquad(mono, 'lp', 120))) - db(rms(biquad(biquad(mono, 'hp', 400), 'lp', 2000))) - over;
  if (!(excess > 0)) return 0;
  const k = 1 - undb(-Math.min(8, excess));
  for (const ch of [t.L, t.R]) { const lo = biquad(ch, 'lp', 160); for (let i = 0; i < n; i++) ch[i] -= lo[i] * k; }
  return Math.min(8, excess);
}
const peakOf = (t) => { let m = 0; for (let i = 0; i < t.n; i++) m = Math.max(m, Math.abs(t.L[i]), Math.abs(t.R[i])); return m; };

// A fader ride by section energy, like a mixer pushing the chorus: each 0.1 below 1.0 is −1.2 dB, eased over 0.15 s
// at the cut. Without it the loudness target levels a quiet verse and the drop to within a dB of each other.
function rideEnergy(t, sections, dur) {
  const target = new Float32Array(t.n).fill(1);
  sections.forEach((s, i) => { const g = undb(-12 * (1 - Math.min(1, s.energy))); for (let j = N(s.t); j < Math.min(t.n, N(sections[i + 1]?.t ?? dur + 1)); j++) target[j] = g; });
  const k = Math.exp(-1 / (0.05 * RATE));
  let g = target[0];
  for (let i = 0; i < t.n; i++) { g = target[i] + (g - target[i]) * k; t.L[i] *= g; t.R[i] *= g; }
}
// Gain automation: the breath before the drop (near-silence for `suck` seconds, straight back on the downbeat) and the
// ending (button/stop cut everything at `end`).
function automate(p) {
  const n = N(p.duration), g = new Float32Array(n).fill(1);
  const ramp = (at, len, from, to) => { const a = N(at), m = N(len); for (let i = 0; i < m && a + i < n; i++) if (a + i >= 0) g[a + i] = Math.min(g[a + i], from + (to - from) * (i / m)); };
  const hold = (at, until, v) => { for (let i = Math.max(0, N(at)); i < Math.min(n, N(until)); i++) g[i] = Math.min(g[i], v); };
  if (p.drop != null) { ramp(p.drop - p.suck, 0.03, 1, 0.03); hold(p.drop - p.suck + 0.03, p.drop - 0.003, 0.03); }
  if (p.end != null) { const len = p.ending === 'stop' ? 0.02 : 0.012; ramp(p.end, len, 1, 0); hold(p.end + len, p.duration + 1, 0); }
  return g;
}
// A low-pass that opens from ~700 Hz to fully open between `from` and `to` (seconds): the classic build.
function buildSweep(t, from, to) {
  if (!(to > from) || from < 0) return;
  const n = t.n, fc = (u) => { const tt = u * n / RATE; if (tt < from || tt > to + 0.05) return 20000; const x = Math.min(1, (tt - from) / (to - from)); return 700 * Math.pow(20000 / 700, x * x); };
  t.L.set(biquad(t.L, 'lp', fc, 0.9)); t.R.set(biquad(t.R, 'lp', fc, 0.9));
}
const applyGain = (t, g) => { for (let i = 0; i < t.n; i++) { t.L[i] *= g[i]; t.R[i] *= g[i]; } };

function toWav(t) {
  const n = t.n, buf = Buffer.alloc(44 + n * 4), r = rng(1);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  const q = (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767 + (r() - r()))));
  for (let i = 0; i < n; i++) { buf.writeInt16LE(q(t.L[i]), 44 + i * 4); buf.writeInt16LE(q(t.R[i]), 46 + i * 4); }
  return buf;
}

/**
 * The music for a video: a 48 kHz stereo 16-bit WAV composed on its cuts.
 * o: { id, duration, cuts: [{ id, t }], style?, product?, drop?, ending?, brand?, seed?, voiced?, lufs? }
 */
export function composeMusic(o) {
  const probe = {
    id: o.id,
    duration: o.duration,
    labels: Object.fromEntries((o.cuts || []).map((c) => [`scene:${c.id}`, c.t])),
    music: { style: o.style, product: o.product, drop: o.drop, ending: o.ending, brand: o.brand, seed: o.seed },
    voice: !!o.voiced,
  };
  resetVoices();
  const p = plan(probe);
  const music = new Track(p.duration), fxm = new Track(p.duration);
  const r = rng(`music:${p.style}:${p.seed}:${p.bpm}`);
  const bus = Object.fromEntries(['pad', 'bass', 'drums', 'keys', 'arp', 'lead'].map((k) => [k, new Track(p.duration)]));
  const { kicks } = renderScore(p, { music, ...bus, fx: fxm }, r);
  pump(bus.pad, kicks, p.S.pump || 0, p.B);
  pump(bus.bass, kicks, 0.5, p.B, 0.35); // the bass steps aside for the kick, so the low end is one punch, not mud
  for (const t of [...Object.values(bus), fxm]) for (let i = 0; i < music.n; i++) { music.L[i] += t.L[i]; music.R[i] += t.R[i]; }
  const [wet, size] = p.S.reverb || [0.12, 1];
  reverb(music.L, music.R, wet, size);
  if (p.drop != null) buildSweep(music, p.drop - 2 * 4 * p.B, p.drop - p.suck);
  rideEnergy(music, p.sections, p.duration);
  applyGain(music, automate(p));
  const fade = p.end != null ? 0 : Math.min(1.2, p.duration * 0.1);
  for (let i = 0; i < music.n; i++) { const t = i / RATE, g = Math.min(1, t / 0.03, fade ? (p.duration - t) / fade : 1); music.L[i] *= g; music.R[i] *= g; }
  master(p, music.L, music.R, r);
  balanceLows(music);
  // levelled to the target, no sub rumble (speakers can't play it, limiters choke on it), one gentle glue compressor
  const ml = loudness(music.L, music.R);
  if (isFinite(ml)) music.scale(undb((o.lufs ?? -18) - ml));
  music.L = biquad(music.L, 'hp', 30); music.R = biquad(music.R, 'hp', 30);
  compress(music, -16, 2.5);
  const cl = loudness(music.L, music.R);
  if (isFinite(cl)) music.scale(undb((o.lufs ?? -18) - cl)); // back to the target the compressor took it under
  limit(music, undb(-1.5));
  return { wav: toWav(music), lufs: loudness(music.L, music.R), style: p.style, bpm: p.bpm, about: describe(p), sections: p.sections.map((s) => ({ id: s.id, t: s.t, energy: s.energy })) };
}
