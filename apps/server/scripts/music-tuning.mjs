// How in tune the composer's music is, per style (24 Nov 2026; the measure is scripts/music/tuning.js): a 24 s piece
// for each style, and the share of its tonal energy off pitch and outside its key.
// Usage: node scripts/music-tuning.mjs [style,style…] [--no-drums]   (one line per style, then the average)
// --no-drums measures the pitched parts alone: the drums' pitch sweeps and noise read as "off pitch" without being notes.
import { DRUMS } from './music/score.js'
import { STYLES, composeMusic } from './music/soundtrack.js'
import { tuningOf } from './music/tuning.js'

if (process.argv.includes('--no-drums')) for (const k of Object.keys(DRUMS)) DRUMS[k] = () => new Float32Array(1)
const pick = process.argv.slice(2).find((a) => !a.startsWith('--'))
const styles = pick ? pick.split(',') : Object.keys(STYLES)
const cuts = [{ id: 'title', t: 0 }, { id: 's1', t: 3 }, { id: 's2', t: 9 }, { id: 's3', t: 15 }, { id: 'close', t: 20.5 }]
const pc = (x) => `${(x * 100).toFixed(1).padStart(5)}%`
const rows = []
for (const style of styles) {
  const r = composeMusic({ id: 'tuning', brand: 'tuning', duration: 24, cuts, style, voiced: false, lufs: -18 })
  const t = tuningOf(r.wav, r.about)
  rows.push(t)
  console.log(`${style.padEnd(10)} ${r.about.padEnd(44)} off>10c ${pc(t.off10)}  off>20c ${pc(t.off20)}  out of key ${pc(t.outKey)}  fine off>4c ${pc(t.fine)}`)
}
const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length
console.log(`AVERAGE    off>10c ${pc(avg('off10'))}  off>20c ${pc(avg('off20'))}  out of key ${pc(avg('outKey'))}  fine off>4c ${pc(avg('fine'))}`)
