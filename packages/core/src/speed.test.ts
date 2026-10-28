// Speed ramps, the pitch toggle and smooth slow motion (E-17): one time mapping (speed.ts) that the preview, the
// export (HyperFrames' rate lane), trims, splits, linked sound, freeze frames, the transcript and captions share.
import { describe, expect, it } from 'vitest'
import {
  RAMP_PRESETS,
  addAsset,
  addItem,
  applyRampPreset,
  applySmoothCopy,
  clipSourceAt,
  compileToHyperFrames,
  createAudioItem,
  createProject,
  createVideoItem,
  dropSmoothJob,
  evaluate,
  exportVideoTiming,
  findItem,
  freezeFrame,
  generateCaptions,
  itemEnd,
  itemWords,
  localAtOffset,
  mainTrack,
  pendingSmoothJobs,
  rampIntegral,
  rampPresetOf,
  rampRate,
  rampShape,
  rampSolve,
  rateLane,
  separateAudio,
  setItemSpeed,
  setKeyframe,
  setPitchShift,
  setSmoothJob,
  setSpeedRamp,
  shiftsPitch,
  smoothFps,
  smoothRange,
  smoothSource,
  smoothState,
  sourceOffset,
  sourceSpan,
  speedAt,
  splitItem,
  trimItem,
  updateItem,
  varispeedSlices,
  type Asset,
  type AudioItem,
  type Project,
  type SpeedPoint,
  type VideoItem,
} from './index'

const video = (id: string, duration = 30, extra: Partial<Asset> = {}): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration, width: 1920, height: 1080, fps: 30, hasAudio: true, ...extra })
const opts = { assetPath: (id: string) => `assets/${id}`, runtimePath: 'runtime.js', gsapPath: 'gsap.min.js', fontFaceCss: '' }

// ---------- HyperFrames as it reads a rate lane ----------

/**
 * hyperframes 0.8.70 (core/dist/audioAutomation.js `sampleAutomationLane` with the "log" scale, and
 * core/dist/speedRamp.js `buildTable` / `sourceTimeAt`), copied so the test checks the export against the engine's
 * own arithmetic: speeds sampled on a log scale, integrated with trapezoids in 48 cells per segment.
 */
const hfTables = new WeakMap<object, { ts: number[]; ss: number[]; first: number; last: number }>()

function hfSourceTimeAt(lane: Array<{ t: number; v: number }>, t: number): number {
  let table = hfTables.get(lane)
  if (!table) hfTables.set(lane, (table = hfTable(lane)))
  const { ts, ss } = table
  const last = ts.length - 1
  if (t <= 0) return t * table.first
  if (t >= ts[last]) return ss[last] + (t - ts[last]) * table.last
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ts[mid] <= t) lo = mid
    else hi = mid
  }
  return ss[lo] + ((ss[hi] - ss[lo]) * (t - ts[lo])) / (ts[hi] - ts[lo])
}

function hfTable(lane: Array<{ t: number; v: number }>): { ts: number[]; ss: number[]; first: number; last: number } {
  const pts = lane.map((q) => ({ t: Math.max(0, q.t), v: Math.min(10, Math.max(0.1, q.v)) })).sort((a, b) => a.t - b.t)
  const sample = (x: number) => {
    if (x <= pts[0].t) return pts[0].v
    const last = pts[pts.length - 1]
    if (x >= last.t) return last.v
    let lo = 0
    let hi = pts.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (pts[mid].t <= x) lo = mid
      else hi = mid
    }
    const a = pts[lo]
    const b = pts[hi]
    const u = (x - a.t) / (b.t - a.t)
    return Math.exp(Math.log(a.v) + (Math.log(b.v) - Math.log(a.v)) * u)
  }
  const ts = [0]
  const ss = [0]
  const push = (x: number) => {
    const prev = ts[ts.length - 1]
    if (x <= prev) return
    const r0 = sample(prev)
    ts.push(x)
    ss.push(ss[ss.length - 1] + ((r0 + sample(x)) / 2) * (x - prev))
  }
  push(Math.max(0, pts[0].t))
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].t
    const b = pts[i].t
    if (b <= 0) continue
    for (let k = 1; k <= 48; k++) push(Math.max(a, 0) + ((b - a) * k) / 48)
  }
  return { ts, ss, first: pts[0].v, last: pts[pts.length - 1].v }
}

interface MediaTag {
  id: string
  start: number
  duration: number
  mediaStart: number
  src: string
  rate?: number
  lane?: Array<{ t: number; v: number }>
}

function tags(html: string, tag: 'video' | 'audio'): MediaTag[] {
  return [...html.matchAll(new RegExp(`<${tag} id="${tag === 'video' ? 'v' : 'a'}-([^"]+)"[^>]*>`, 'g'))].map((m) => {
    const el = m[0]
    const num = (name: string) => {
      const x = el.match(new RegExp(` ${name}="([-\\d.]+)"`))
      return x ? Number(x[1]) : undefined
    }
    const auto = el.match(/data-automation='([^']+)'/)
    const lanes = auto ? (JSON.parse(auto[1]).lanes as Array<{ target: string; points: Array<{ t: number; v: number }> }>) : []
    return { id: m[1].replace(/-p\d+$/, ''), start: num('data-start')!, duration: num('data-duration')!, mediaStart: num('data-media-start')!, src: el.match(/ src="([^"]+)"/)![1], rate: num('data-playback-rate'), lane: lanes.find((l) => l.target === 'rate')?.points }
  })
}

/** Source time HyperFrames shows (or plays) for an element at timeline time t. */
const exportTime = (tag: MediaTag, t: number) => tag.mediaStart + (tag.lane ? hfSourceTimeAt(tag.lane, t - tag.start) : (t - tag.start) * (tag.rate ?? 1))

/**
 * At many moments, the export's picture and sound are at the source time the preview shows and plays (within a
 * millisecond: a frame at 240 fps is 4 ms).
 */
function expectExportMatchesPreview(p: Project, step = 0.0237) {
  const html = compileToHyperFrames(p, opts)
  const videos = tags(html, 'video')
  const audios = tags(html, 'audio')
  let checked = 0
  const end = Math.max(...videos.map((v) => v.start + v.duration), ...audios.map((a) => a.start + a.duration))
  for (let t = 0; t < end; t += step) {
    const frame = evaluate(p, t)
    for (const v of videos) {
      if (t < v.start || t >= v.start + v.duration - 1e-6) continue
      const layer = frame.layers.find((l) => l.itemId === v.id)
      if (!layer) continue
      expect(Math.abs(exportTime(v, t) - layer.mediaTime!), `picture of ${v.id} at ${t.toFixed(3)}`).toBeLessThan(1e-3)
      checked++
    }
    for (const a of audios) {
      if (t < a.start || t >= a.start + a.duration - 1e-6) continue
      const heard = frame.audio.find((x) => x.itemId === a.id)
      expect(heard, `sound of ${a.id} at ${t.toFixed(3)}`).toBeTruthy()
      expect(Math.abs(exportTime(a, t) - heard!.mediaTime), `sound of ${a.id} at ${t.toFixed(3)}`).toBeLessThan(1e-3)
      checked++
    }
  }
  expect(checked).toBeGreaterThan(100)
  return { videos, audios }
}

/** One 8 s clip of a 30 s recording on the main track, from 5 s into it. */
function oneClip(over: Partial<VideoItem> = {}): { p: Project; id: string } {
  let p = createProject()
  p = addAsset(p, video('rec'))
  p = addItem(p, createVideoItem(p.assets.rec, 0, { in: 5, duration: 8, ...over }))
  return { p, id: mainTrack(p)!.items[0].id }
}

const clip = (p: Project, id: string) => findItem(p, id)!.item as VideoItem

describe('the time mapping', () => {
  const ramp: SpeedPoint[] = [{ t: 0, v: 0.5 }, { t: 2, v: 2 }, { t: 3, v: 2 }, { t: 5, v: 0.2 }]

  it('integrates the speed exactly, before, inside and after the points', () => {
    // a numeric integral of the sampled speed
    const numeric = (a: number, b: number) => {
      let s = 0
      const n = 20000
      for (let i = 0; i < n; i++) s += rampRate(ramp, a + ((i + 0.5) * (b - a)) / n) * ((b - a) / n)
      return s
    }
    for (const [a, b] of [[0, 1], [0, 2], [0.5, 4.2], [-1, 0], [4, 7], [-2, 9]]) expect(rampIntegral(ramp, a, b)).toBeCloseTo(numeric(a, b), 6)
    // before the first point it holds the first speed, after the last the last
    expect(rampIntegral(ramp, -1, 0)).toBeCloseTo(0.5, 9)
    expect(rampIntegral(ramp, 5, 6)).toBeCloseTo(0.2, 9)
  })

  it('finds the clip time for a source time, either side of the start', () => {
    for (const x of [-1.5, -0.2, 0.3, 1.9, 2.5, 3.7, 4.99, 6.5]) {
      const off = x >= 0 ? rampIntegral(ramp, 0, x) : -rampIntegral(ramp, x, 0)
      expect(rampSolve(ramp, off)).toBeCloseTo(x, 9)
    }
  })

  it('agrees with how HyperFrames plays a rate lane', () => {
    for (let x = 0; x < 6; x += 0.05) expect(Math.abs(hfSourceTimeAt(ramp, x) - rampIntegral(ramp, 0, x))).toBeLessThan(5e-4)
  })

  it('a constant speed maps as before', () => {
    const { p, id } = oneClip({ speed: 2, duration: 4 })
    const it = clip(p, id)
    expect(sourceOffset(it, 1.5)).toBe(3)
    expect(localAtOffset(it, 3)).toBe(1.5)
    expect(sourceSpan(it)).toBe(8)
    expect(speedAt(it, 2)).toBe(2)
  })
})

describe('speed ramps (E-17)', { timeout: 60_000 }, () => {
  it('a preset keeps the clip on the same stretch of its recording and changes its length', () => {
    const { p, id } = oneClip()
    for (const preset of RAMP_PRESETS) {
      const q = applyRampPreset(p, id, preset.id)
      const it = clip(q, id)
      expect(it.in).toBe(5)
      expect(sourceSpan(it)).toBeCloseTo(8, 3)
      expect(rampPresetOf(it)).toBe(preset.id)
      // the clip is as long as the stretch over the ramp's average speed, which `speed` now holds
      expect(it.duration * it.speed).toBeCloseTo(8, 2)
      expect(rampShape(it)!.map((s) => s.v)).toEqual(preset.shape.map((s) => s.v))
    }
    // ramp up: slow at the start, fast at the end
    const up = clip(applyRampPreset(p, id, 'rampUp'), id)
    expect(speedAt(up, 0)).toBeCloseTo(0.5, 6)
    expect(speedAt(up, up.duration)).toBeCloseTo(2, 6)
    expect(speedAt(up, up.duration / 2)).toBeCloseTo(1, 6)
  })

  it('the preview shows the frames the ramp reaches, and the export renders the same ones', () => {
    const { p, id } = oneClip()
    for (const preset of RAMP_PRESETS) {
      const q = applyRampPreset(p, id, preset.id)
      const it = clip(q, id)
      // the first and last frames are the stretch's ends
      expect(evaluate(q, 0).layers[0].mediaTime).toBeCloseTo(5, 6)
      expect(evaluate(q, it.duration - 1e-6).layers[0].mediaTime).toBeCloseTo(13, 3)
      const { videos, audios } = expectExportMatchesPreview(q)
      expect(videos[0].lane).toBeTruthy()
      expect(videos[0].rate).toBeUndefined()
      expect(audios[0].lane).toBeTruthy()
    }
  })

  it('the sound is heard at the speed of the moment', () => {
    const { p, id } = oneClip()
    const q = applyRampPreset(p, id, 'rampUp')
    const it = clip(q, id)
    const heard = (t: number) => evaluate(q, t).audio[0]
    expect(heard(0).speed).toBeCloseTo(0.5, 6)
    expect(heard(it.duration * 0.999).speed).toBeCloseTo(2, 2)
    expect(heard(it.duration / 2).mediaTime).toBeCloseTo(clipSourceAt(it, it.duration / 2), 9)
  })

  it('keyframes, fades and animations stay on their frames when the ramp changes the length', () => {
    let { p, id } = oneClip({ fadeIn: 1, fadeOut: 1, animations: { in: { preset: 'fade', duration: 0.5 } } })
    p = setKeyframe(p, id, 'opacity', 4, 0.5)
    const before = clip(p, id)
    const srcOf = (it: VideoItem, local: number) => clipSourceAt(it, local)
    const q = applyRampPreset(p, id, 'hero')
    const it = clip(q, id)
    const kf = it.keyframes.opacity![0]
    expect(srcOf(it, kf.t)).toBeCloseTo(srcOf(before, 4), 3)
    expect(srcOf(it, it.fadeIn)).toBeCloseTo(srcOf(before, 1), 3)
    expect(srcOf(it, it.duration - it.fadeOut)).toBeCloseTo(srcOf(before, 7), 3)
    expect(srcOf(it, it.animations.in!.duration)).toBeCloseTo(srcOf(before, 0.5), 3)
    // and back to a constant speed: the same frames again
    const back = clip(setItemSpeed(q, id, 1), id)
    expect(back.speedRamp).toBeUndefined()
    expect(back.duration).toBeCloseTo(8, 3)
    expect(back.keyframes.opacity![0].t).toBeCloseTo(4, 2)
  })

  it('no ramp: the clip plays at its average speed and keeps its length', () => {
    const { p, id } = oneClip()
    const q = applyRampPreset(p, id, 'rampDown')
    const r = clip(setSpeedRamp(q, id, null), id)
    expect(r.speedRamp).toBeUndefined()
    expect(r.duration).toBeCloseTo(clip(q, id).duration, 2)
    expect(sourceSpan(r)).toBeCloseTo(8, 2)
  })

  it('a shape drawn by hand is cleaned up: inside the clip, in range, with both ends', () => {
    const { p, id } = oneClip()
    const q = setSpeedRamp(p, id, [{ t: 0.5, v: 50 }, { t: -1, v: 0.01 }, { t: 0.5, v: 3 }])
    const s = rampShape(clip(q, id))!
    expect(s.map((x) => x.t)).toEqual([0, 0.5, 1])
    expect(s.map((x) => x.v)).toEqual([0.1, 3, 3])
    expect(rampPresetOf(clip(q, id))).toBeNull()
  })

  it('trims keep every frame where it was, and stop at the ends of the recording', () => {
    const { p, id } = oneClip()
    const q = applyRampPreset(p, id, 'montage')
    const it0 = clip(q, id)
    const at = (pp: Project, t: number) => evaluate(pp, t).layers[0].mediaTime!
    // trim the start 1.5 s later: what was at 2..4 s is still there (the main track packs, so shift by 1.5)
    const a = trimItem(q, id, 'start', 1.5)
    for (const t of [2, 2.7, 3.3, 4]) expect(at(a, t - 1.5)).toBeCloseTo(at(q, t), 3)
    expect(clip(a, id).in).toBeCloseTo(clipSourceAt(it0, 1.5), 3)
    // trim the end in: the frames before stay
    const b = trimItem(q, id, 'end', it0.duration - 1)
    for (const t of [0.5, 2, 3.9]) expect(at(b, t)).toBeCloseTo(at(q, t), 6)
    // extend the end as far as it goes: up to the end of the 30 s recording, along the ramp's last speed
    const c = clip(trimItem(q, id, 'end', 999), id)
    expect(c.in + sourceSpan(c)).toBeCloseTo(30, 3)
    // after another clip, the start back past the recording's start: stops at its first frame
    let two = createProject()
    two = addAsset(two, video('first'))
    two = addAsset(two, video('rec'))
    two = addItem(two, createVideoItem(two.assets.first, 0, { duration: 8 }))
    two = addItem(two, createVideoItem(two.assets.rec, 99, { in: 5, duration: 8 }))
    const second = mainTrack(two)!.items[1].id
    const d = clip(trimItem(applyRampPreset(two, second, 'montage'), second, 'start', -999), second)
    expect(d.in).toBe(0)
    expect(speedAt(d, 0)).toBeCloseTo(1, 6)
    expectExportMatchesPreview(a)
    expectExportMatchesPreview(trimItem(q, id, 'end', 999))
  })

  it('a split leaves both pieces on the frames the whole clip showed, in the preview and the export', () => {
    const { p, id } = oneClip()
    const q = applyRampPreset(p, id, 'bullet')
    const it = clip(q, id)
    const cut = it.duration * 0.55
    const r = splitItem(q, id, cut)
    const right = clip(r.project, r.rightId!)
    expect(right.in).toBeCloseTo(clipSourceAt(it, cut), 3)
    for (let t = 0.1; t < it.duration; t += 0.37) expect(evaluate(r.project, t).layers[0].mediaTime).toBeCloseTo(evaluate(q, t).layers[0].mediaTime!, 3)
    // each piece's average speed is its own again
    expect(clip(r.project, id).speed).not.toBeCloseTo(right.speed, 2)
    expectExportMatchesPreview(r.project)
  })

  it('a transition into and out of a ramped clip plays the footage either side at its end speeds', () => {
    let p = createProject()
    p = addAsset(p, video('a'))
    p = addAsset(p, video('b'))
    p = addAsset(p, video('c'))
    p = addItem(p, createVideoItem(p.assets.a, 0, { duration: 4, transitionOut: { type: 'crossfade', duration: 1 } }))
    p = addItem(p, createVideoItem(p.assets.b, 99, { in: 6, duration: 6, transitionOut: { type: 'crossfade', duration: 1 } }))
    p = addItem(p, createVideoItem(p.assets.c, 99, { in: 3, duration: 4 }))
    const b = mainTrack(p)!.items[1].id
    const q = applyRampPreset(p, b, 'rampDown')
    const it = clip(q, b)
    // the incoming pre-roll plays the source before the in-point at the ramp's first speed (2x)
    const tm = exportVideoTiming(q, 0, 1)
    expect(tm.from).toBeCloseTo(it.start - 0.5, 6)
    expect(tm.mediaStart).toBeCloseTo(6 - 0.5 * 2, 6)
    expectExportMatchesPreview(q)
  })

  it('separated sound keeps the ramp, and a ramp given later reaches the linked sound too', () => {
    // ramp first, then separate
    const { p, id } = oneClip()
    const sep = separateAudio(applyRampPreset(p, id, 'hero'), id)
    const audio = sep.tracks.flatMap((t) => t.items).find((i) => i.type === 'audio') as AudioItem
    expect(audio.speedRamp).toEqual(clip(sep, id).speedRamp)
    expectExportMatchesPreview(sep)
    // separate first, then ramp: both get it and stay together
    const q = applyRampPreset(separateAudio(p, id), id, 'montage')
    const a2 = q.tracks.flatMap((t) => t.items).find((i) => i.type === 'audio') as AudioItem
    expect(a2.speedRamp).toEqual(clip(q, id).speedRamp)
    expect(a2.duration).toBe(clip(q, id).duration)
    for (const t of [0.3, 2.2, 5.1]) {
      const f = evaluate(q, t)
      expect(f.audio.find((x) => x.itemId === a2.id)!.mediaTime).toBeCloseTo(f.layers[0].mediaTime!, 6)
    }
    expectExportMatchesPreview(q)
  })

  it('a freeze frame on a ramped clip holds the frame shown at that moment', () => {
    const { p, id } = oneClip()
    const q = applyRampPreset(p, id, 'rampUp')
    const t = 3.1
    const shown = evaluate(q, t).layers[0].mediaTime!
    const r = freezeFrame(q, id, t, 1)
    const frozen = mainTrack(r)!.items.find((i) => i.type === 'video' && i.freezeAt !== undefined) as VideoItem
    expect(frozen.freezeAt).toBeCloseTo(shown, 3)
    // after the hold the clip carries on from the same frame
    expect(evaluate(r, t + 1 + 1e-3).layers[0].mediaTime).toBeCloseTo(shown, 2)
  })

  it('the transcript and captions follow the ramp', () => {
    const transcript = { language: 'en', engine: 'test', segments: [{ start: 6, end: 12, text: 'one two three four', words: [{ w: 'one', start: 6, end: 6.5 }, { w: 'two', start: 8, end: 8.4 }, { w: 'three', start: 10, end: 10.5 }, { w: 'four', start: 11.5, end: 12 }] }] }
    let p = createProject()
    p = addAsset(p, video('rec', 30, { transcript }))
    p = addItem(p, createVideoItem(p.assets.rec, 0, { in: 5, duration: 8 }))
    const id = mainTrack(p)!.items[0].id
    const q = applyRampPreset(p, id, 'rampUp')
    // each word is where the preview plays it: the clip shows the word's source time at the word's timeline time
    for (const w of itemWords(q, id)) {
      expect(evaluate(q, w.start).layers[0].mediaTime).toBeCloseTo(w.srcStart, 3)
      expect(evaluate(q, w.end - 1e-6).layers[0].mediaTime).toBeCloseTo(w.srcEnd, 3)
    }
    const caps = generateCaptions(q)
    const line = caps.tracks.find((t) => t.kind === 'caption')!.items.find((l) => l.type === 'caption' && l.words?.some((w) => w.w === 'three'))!
    const three = (line.type === 'caption' ? line.words! : []).find((w) => w.w === 'three')!
    expect(evaluate(q, line.start + three.start).audio[0].mediaTime).toBeCloseTo(10, 2)
  })
})

describe('the pitch toggle (E-17)', () => {
  it('keeps the pitch by default; set to follow the speed, the preview and the export both shift it', () => {
    const { p, id } = oneClip({ speed: 2, duration: 4 })
    expect(shiftsPitch(clip(p, id))).toBe(false)
    expect(evaluate(p, 1).audio[0].pitchShift).toBeUndefined()
    const q = setPitchShift(p, id, true)
    expect(shiftsPitch(clip(q, id))).toBe(true)
    expect(evaluate(q, 1).audio[0].pitchShift).toBe(true)
    // the export plays the server's resampled copy (already at the clip's speed) in place of the source
    const html = compileToHyperFrames(q, { ...opts, pitchShiftPath: (x) => (x === id ? 'pitch/x.wav' : undefined) })
    const [a] = tags(html, 'audio')
    expect(a.src).toBe('pitch/x.wav')
    expect(a.rate).toBeUndefined()
    expect(a.lane).toBeUndefined()
    expect(a.mediaStart).toBe(0)
    // at 1x there is no pitch to shift
    expect(shiftsPitch(clip(setItemSpeed(q, id, 1), id))).toBe(false)
  })

  it('the resampled copy is made of slices that play the same source as the preview, end to end', () => {
    const { p, id } = oneClip()
    const q = setPitchShift(applyRampPreset(p, id, 'hero'), id, true)
    const it = clip(q, id)
    const slices = varispeedSlices(it, it.start, itemEnd(it))
    expect(slices.length).toBeGreaterThan(10)
    expect(slices[0].from).toBeCloseTo(5, 6)
    expect(slices[slices.length - 1].to).toBeCloseTo(13, 3)
    expect(slices.reduce((s, x) => s + x.len, 0)).toBeCloseTo(it.duration, 6)
    for (let i = 1; i < slices.length; i++) expect(slices[i].from).toBeCloseTo(slices[i - 1].to, 9)
    // at each slice's start the copy is at the moment the preview plays
    let t = it.start
    for (const s of slices) {
      expect(s.from).toBeCloseTo(evaluate(q, t).audio[0].mediaTime, 6)
      t += s.len
    }
    // a constant speed is one slice
    expect(varispeedSlices(clip(setItemSpeed(q, id, 2), id), 0, 4)).toHaveLength(1)
  })

  it('a linked sound follows the toggle', () => {
    const { p, id } = oneClip()
    const q = setPitchShift(separateAudio(p, id), id, true)
    const audio = q.tracks.flatMap((t) => t.items).find((i) => i.type === 'audio') as AudioItem
    expect(audio.pitchShift).toBe(true)
  })
})

describe('smooth slow motion (E-17)', { timeout: 60_000 }, () => {
  it('is offered for a slowed clip whose file has too few frames', () => {
    const { p, id } = oneClip()
    expect(smoothFps(p, clip(p, id))).toBe(0)
    expect(smoothFps(setItemSpeed(p, id, 0.5), clip(setItemSpeed(p, id, 0.5), id))).toBe(60)
    const hero = applyRampPreset(p, id, 'hero')
    expect(smoothFps(hero, clip(hero, id))).toBe(100)
    // 240 fps footage already has the frames
    const fast = { ...p, assets: { ...p.assets, rec: { ...p.assets.rec, fps: 240 } } }
    expect(smoothFps(fast, clip(fast, id))).toBe(0)
  })

  it('while the copy is made the clip says so; once made the picture plays from it, the sound from the source', () => {
    const { p, id } = oneClip()
    let q = setItemSpeed(p, id, 0.5)
    const range = smoothRange(q, clip(q, id))
    expect(range).toEqual({ from: 4, to: 14 })
    q = setSmoothJob(q, id, { ...range, fps: 60, jobId: 'jb_1' })
    expect(smoothState(q, clip(q, id))).toBe('making')
    expect(pendingSmoothJobs(q)).toEqual(['jb_1'])
    // a split while it is made: both pieces get the copy
    const s = splitItem(q, id, 4)
    const copy: Asset = { id: 'smooth1', kind: 'video', name: 'rec smooth', src: 'smooth1.mp4', duration: 10, width: 1920, height: 1080, fps: 60 }
    const done = applySmoothCopy(s.project, 'jb_1', copy)
    expect(done.assets.smooth1).toBeTruthy()
    expect(smoothState(done, clip(done, id))).toBe('ready')
    expect(smoothState(done, clip(done, s.rightId!))).toBe('ready')
    // the preview's picture: the copy at source time minus its start; the sound: the recording
    const f = evaluate(done, 2)
    expect(f.layers[0].assetId).toBe('smooth1')
    expect(f.layers[0].mediaTime).toBeCloseTo(5 + 1 - 4, 6)
    expect(f.audio[0].assetId).toBe('rec')
    expect(f.audio[0].mediaTime).toBeCloseTo(6, 6)
    // the export plays the copy at the same moments
    const { videos } = expectExportMatchesPreview(done)
    expect(videos.every((v) => v.src === 'assets/smooth1')).toBe(true)
  })

  it('a clip trimmed past its copy goes back to the source, and a failed job leaves the clip as it was', () => {
    const { p, id } = oneClip({ speed: 0.5, duration: 16 })
    const range = smoothRange(p, clip(p, id))
    const copy: Asset = { id: 'smooth1', kind: 'video', name: 'rec smooth', src: 'smooth1.mp4', duration: range.to - range.from, fps: 60 }
    const done = applySmoothCopy(setSmoothJob(p, id, { ...range, fps: 60, jobId: 'jb_1' }), 'jb_1', copy)
    expect(smoothSource(done, clip(done, id))).toBeTruthy()
    const longer = trimItem(done, id, 'end', 40)
    expect(smoothState(longer, clip(longer, id))).toBe('stale')
    expect(evaluate(longer, 1).layers[0].assetId).toBe('rec')
    expect(tags(compileToHyperFrames(longer, opts), 'video')[0].src).toBe('assets/rec')
    const failed = dropSmoothJob(setSmoothJob(p, id, { ...range, fps: 60, jobId: 'jb_2' }), 'jb_2')
    expect(clip(failed, id).smooth).toBeUndefined()
  })
})

describe('the export lanes', { timeout: 60_000 }, () => {
  it('a lane starts at the element: points before it are cut at the speed of that moment', () => {
    const { p, id } = oneClip()
    const q = applyRampPreset(p, id, 'rampUp')
    const it = clip(q, id)
    const lane = rateLane(it, it.start + 2)!
    expect(lane[0]).toEqual({ t: 0, v: expect.closeTo(speedAt(it, 2), 5) })
    expect(lane[lane.length - 1].t).toBeCloseTo(it.duration - 2, 3)
    // an element that starts early (a transition's pre-roll) runs at the first speed until the clip starts
    const early = rateLane(it, it.start - 0.5)!
    expect(early[0].v).toBeCloseTo(0.5, 6)
    expect(early[1].t).toBeCloseTo(0.5, 6)
  })

  it('a reversed clip or a freeze frame ignores a ramp it still carries', () => {
    const { p, id } = oneClip()
    const q = updateItem<VideoItem>(applyRampPreset(p, id, 'rampUp'), id, { reverse: true })
    expect(rateLane(clip(q, id), 0)).toBeNull()
    expect(speedAt(clip(q, id), 1)).toBe(clip(q, id).speed)
    expect(applyRampPreset(q, id, 'hero')).toBe(q)
  })

  it('constant speed still plays as a playback rate', () => {
    const { p, id } = oneClip({ speed: 1.5, duration: 4 })
    const { videos } = expectExportMatchesPreview(p)
    expect(videos[0].rate).toBe(1.5)
    expect(videos[0].lane).toBeUndefined()
    void createAudioItem
  })
})
