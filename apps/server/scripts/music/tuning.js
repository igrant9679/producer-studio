// How in tune a composed piece is (Producer's, 24 Nov 2026; not part of huashu-motion). The owner heard the composed
// music as out of tune; this is the measure the fix was made against (scripts/music-tuning.mjs runs it per style, and
// a test keeps it from drifting back). The tonal peaks of the mix are found by short-time FFT and placed against
// equal temperament (A = 440 Hz):
//  - off10 / off20: the share of tonal energy (150-2500 Hz, 16384-point frames) more than 10 / 20 cents off a note;
//  - outKey: the share on pitch classes outside the piece's key (wrong notes; a minor key's raised 7th counts);
//  - fine: the share more than 4 cents off (150-1500 Hz, 65536-point frames), which catches copies of a note detuned
//    against each other (they beat, and held chords waver). Rhythmic styles read higher than their notes are: notes
//    repeated fast, and the pad ducking on every kick, add sidebands a few hertz from each note.
// @ts-nocheck

const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10] };
const KEYS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const h = i + k + len / 2, ar = re[i + k], ai = im[i + k], br = re[h] * cr - im[h] * ci, bi = re[h] * ci + im[h] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi; re[h] = ar - br; im[h] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function measure(mono, rate, inKey, N, hop, fmax, tight) {
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  let tot = 0, offA = 0, off20 = 0, outKey = 0;
  for (let s = 0; s + N <= mono.length; s += hop) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = mono[s + i] * win[i];
    fft(re, im);
    const mag = new Float64Array(N / 2);
    let peak = 0;
    for (let k = 0; k < N / 2; k++) { mag[k] = Math.hypot(re[k], im[k]); if (mag[k] > peak) peak = mag[k]; }
    if (peak < 1e-6) continue;
    const lo = Math.ceil((150 * N) / rate), hi = Math.floor((fmax * N) / rate);
    for (let k = lo; k <= hi; k++) {
      const m = mag[k];
      if (m < peak * 0.03 || m < mag[k - 1] || m < mag[k + 1] || m < mag[k - 2] || m < mag[k + 2]) continue;
      const a = Math.log(mag[k - 1]), b = Math.log(m), c = Math.log(mag[k + 1]);
      const f = ((k + (0.5 * (a - c)) / (a - 2 * b + c)) * rate) / N;
      const midi = 69 + 12 * Math.log2(f / 440), dev = Math.abs(midi - Math.round(midi)) * 100, w = m * m;
      tot += w;
      if (dev > tight) offA += w;
      if (dev > 20) off20 += w;
      if (!inKey.has(((Math.round(midi) % 12) + 12) % 12)) outKey += w;
    }
  }
  return { off: offA / tot, off20: off20 / tot, outKey: outKey / tot };
}

/** The tuning of a piece the composer wrote: its 16-bit stereo WAV and its `about` line (which names its key). */
export function tuningOf(wav, about, rate = 48000) {
  const n = (wav.length - 44) / 4, mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (wav.readInt16LE(44 + i * 4) + wav.readInt16LE(46 + i * 4)) / 65536;
  const m = /· ([A-G][♯♭]?) (major|minor|dorian) ·/.exec(about);
  const key = m ? KEYS.indexOf(m[1]) : 0, scale = m ? m[2] : 'major';
  const inKey = new Set(SCALES[scale].map((s) => (s + key) % 12));
  const coarse = measure(mono, rate, inKey, 16384, 8192, 2500, 10);
  const fine = measure(mono, rate, inKey, 65536, 16384, 1500, 4);
  return { off10: coarse.off, off20: coarse.off20, outKey: coarse.outKey, fine: fine.off };
}
