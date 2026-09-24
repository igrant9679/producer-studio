// Offline demo project for /edit/demo: bundled media in /public/demo (generated with ffmpeg), synthetic
// waveforms and word-timed transcripts so captions and transcript editing work without the API.
import type { Asset, Project, Transcript, TranscriptSegment, TranscriptWord } from '@producer/core'
import {
  captionStyleFromPreset,
  createAudioItem,
  createImageItem,
  createProject,
  createTextItem,
  createTrack,
  createVideoItem,
  generateCaptions,
  hash01,
} from '@producer/core'

export const DEMO_KEY = 'ps.demo.project.v1'

/** Spread a phrase's words across [start, end] proportionally to their length. */
function phrase(text: string, start: number, end: number): TranscriptWord[] {
  const words = text.split(/\s+/).filter(Boolean)
  const total = words.reduce((n, w) => n + w.length + 1, 0)
  const span = end - start
  let t = start
  return words.map((w) => {
    const d = (span * (w.length + 1)) / total
    const out = { w, start: +t.toFixed(3), end: +(t + d * 0.9).toFixed(3) }
    t += d
    return out
  })
}

function transcript(parts: Array<[string, number, number]>): Transcript {
  const segments: TranscriptSegment[] = parts.map(([text, s, e]) => ({ start: s, end: e, text, words: phrase(text, s, e) }))
  return { language: 'en', engine: 'demo', segments }
}

/** ~50 peaks per second. Speech: bumps under words; music: pulsing bed. */
function waveform(duration: number, seed: number, words?: TranscriptWord[], music = false): number[] {
  const n = Math.round(duration * 50)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const t = i / 50
    let v: number
    if (music) {
      const beat = Math.exp(-10 * (t % 0.5))
      v = 0.28 + 0.18 * Math.sin(t * Math.PI * 2 * 2) ** 2 + 0.35 * beat + 0.08 * hash01(i + seed)
    } else if (words) {
      const w = words.find((x) => t >= x.start && t <= x.end)
      v = w ? 0.35 + 0.55 * Math.abs(Math.sin(((t - w.start) / Math.max(0.05, w.end - w.start)) * Math.PI)) * (0.7 + 0.3 * hash01(i + seed)) : 0.04 + 0.04 * hash01(i * 3 + seed)
    } else v = 0.15 + 0.1 * hash01(i + seed)
    out.push(+Math.min(1, v).toFixed(3))
  }
  return out
}

function strip(name: string) {
  return { src: `/demo/${name}-strip.jpg`, frames: 10, frameWidth: 160, frameHeight: 90 }
}

export function demoAssets(): Record<string, Asset> {
  const cityT = transcript([
    ['Welcome to Producer Studio.', 0.4, 2.0],
    ['Um, this is a quick tour of the editor.', 3.1, 5.2],
    ['You can cut, trim and caption everything, uh, right in the browser.', 5.4, 7.8],
  ])
  const fractalT = transcript([
    ['Here is the second shot.', 0.3, 2.0],
    ['We zoom into the fractal and, uh, keep the story moving.', 3.1, 6.6],
  ])
  const words = (t: Transcript) => t.segments.flatMap((s) => s.words)
  const now = Date.now()
  const list: Asset[] = [
    {
      id: 'demo_city', kind: 'video', name: 'Test pattern.mp4', src: '/demo/clip-city.mp4', mime: 'video/mp4', duration: 8, width: 1280, height: 720, fps: 30,
      hasAudio: true, sizeBytes: 1395906, thumbnail: '/demo/clip-city-thumb.jpg', filmstrip: strip('clip-city'), waveform: waveform(8, 1, words(cityT)), transcript: cityT, createdAt: now,
    },
    {
      id: 'demo_fractal', kind: 'video', name: 'Fractal zoom.mp4', src: '/demo/clip-fractal.mp4', mime: 'video/mp4', duration: 7, width: 1280, height: 720, fps: 30,
      hasAudio: true, sizeBytes: 1655540, thumbnail: '/demo/clip-fractal-thumb.jpg', filmstrip: strip('clip-fractal'), waveform: waveform(7, 2, words(fractalT)), transcript: fractalT, createdAt: now,
    },
    {
      id: 'demo_aurora', kind: 'video', name: 'Aurora gradient.mp4', src: '/demo/clip-aurora.mp4', mime: 'video/mp4', duration: 6, width: 1280, height: 720, fps: 30,
      hasAudio: true, sizeBytes: 159845, thumbnail: '/demo/clip-aurora-thumb.jpg', filmstrip: strip('clip-aurora'), waveform: waveform(6, 3), createdAt: now,
    },
    {
      id: 'demo_sunrise', kind: 'image', name: 'Sunrise still.png', src: '/demo/still-sunrise.png', mime: 'image/png', width: 1280, height: 720, sizeBytes: 14372,
      thumbnail: '/demo/still-sunrise-thumb.jpg', createdAt: now,
    },
    {
      id: 'demo_music', kind: 'audio', name: 'Warm pulse (music bed).mp3', src: '/demo/music-bed.mp3', mime: 'audio/mpeg', duration: 24, hasAudio: true, sizeBytes: 288750,
      waveform: waveform(24, 4, undefined, true), createdAt: now,
    },
  ]
  return Object.fromEntries(list.map((a) => [a.id, a]))
}

export function buildDemoProject(): Project {
  const p = createProject({ id: 'demo', name: 'Studio demo', width: 1920, height: 1080, fps: 30, background: '#000000' })
  p.assets = demoAssets()
  const A = p.assets
  const main = p.tracks[0]
  const v1 = createVideoItem(A.demo_city, 0, { in: 0.2, duration: 7.6, name: 'Intro', transitionOut: { type: 'crossfade', duration: 0.8 } })
  const v2 = createVideoItem(A.demo_fractal, 7.6, { in: 0, duration: 6.6, name: 'Fractal' })
  const img = createImageItem(A.demo_sunrise, 14.2, { duration: 3, effects: [{ id: 'fx_kb', type: 'kenBurns', intensity: 60 }], transitionOut: { type: 'dipBlack', duration: 0.6 } })
  const v3 = createVideoItem(A.demo_aurora, 17.2, { in: 0, duration: 5, name: 'Outro', filter: { id: 'teal-orange', intensity: 70 } })
  main.items.push(v1, v2, img, v3)

  const textTrack = createTrack('text')
  const title = createTextItem(0.3, 'title-grotesk', { text: 'Producer Studio', name: 'Title', duration: 3.2 })
  title.transform.y = -330
  const chapter = createTextItem(14.4, 'lower-accent', { text: 'Chapter 2 — Colour', name: 'Chapter', duration: 2.6 })
  chapter.transform.x = -380
  chapter.transform.y = 330
  textTrack.items.push(title, chapter)
  p.tracks.push(textTrack)

  const audio = createTrack('audio', { name: 'Music' })
  audio.items.push(createAudioItem(A.demo_music, 0, { duration: 22.2, volume: 0.35, fadeIn: 1, fadeOut: 2, name: 'Music bed' }))
  p.tracks.unshift(audio)

  return generateCaptions(p, { style: captionStyleFromPreset('clean') })
}

export function loadDemoProject(): Project {
  try {
    const raw = localStorage.getItem(DEMO_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Project
      if (p && p.schema === 1 && Array.isArray(p.tracks)) {
        // blob: URLs from local uploads don't survive a reload
        for (const [id, a] of Object.entries(p.assets)) if (a.src.startsWith('blob:')) delete p.assets[id]
        const ids = new Set(Object.keys(p.assets))
        for (const t of p.tracks) t.items = t.items.filter((i) => !('assetId' in i) || ids.has(i.assetId))
        return p
      }
    }
  } catch {
    /* corrupted or unavailable storage */
  }
  return buildDemoProject()
}

export function saveDemoProject(p: Project) {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(p))
  } catch {
    /* quota / private mode */
  }
}

export function resetDemoProject(): Project {
  try {
    localStorage.removeItem(DEMO_KEY)
  } catch {
    /* ignore */
  }
  return buildDemoProject()
}
