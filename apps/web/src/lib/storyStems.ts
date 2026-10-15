// Stories: parse a multi-voice script into lines, lay rendered lines out on one timeline, and build a mixdown plus
// timeline-aligned stems (one per character, same length as the mix, silent where others speak). Pure functions; the
// UI renders each line with VoiceStudio and feeds the decoded samples in.

export interface StoryLine {
  id: string
  /** Character name ('' = narrator). Chapter headings have kind 'heading'. */
  character: string
  text: string
  kind: 'line' | 'heading'
}

export const NARRATOR = 'Narrator'

let n = 0
const lid = () => `l${Date.now().toString(36)}${(n++).toString(36)}`

/**
 * One line per non-empty input line:
 *   `# Chapter title`  → heading
 *   `[Alice] Hello`    → Alice
 *   `ALICE: Hello` / `Alice: Hello` (name ≤ 32 chars, no sentence punctuation) → Alice
 *   anything else      → narrator
 */
export function parseStory(text: string): StoryLine[] {
  const out: StoryLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const h = /^#{1,3}\s+(.+)$/.exec(line)
    if (h) {
      out.push({ id: lid(), character: '', text: h[1].trim(), kind: 'heading' })
      continue
    }
    const br = /^\[([^\]]{1,32})\]\s*(.+)$/.exec(line)
    if (br) {
      out.push({ id: lid(), character: tidyName(br[1]), text: br[2].trim(), kind: 'line' })
      continue
    }
    const co = /^([A-Za-z][\w .'-]{0,31}):\s+(.+)$/.exec(line)
    if (co && !/[.!?]/.test(co[1])) {
      out.push({ id: lid(), character: tidyName(co[1]), text: co[2].trim(), kind: 'line' })
      continue
    }
    out.push({ id: lid(), character: '', text: line, kind: 'line' })
  }
  return out
}

function tidyName(s: string): string {
  const t = s.trim()
  // SHOUTED script names read better as Title Case
  return t === t.toUpperCase() && /[A-Z]/.test(t) ? t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : t
}

/** Characters in order of first appearance (narrator first when present). */
export function castOf(lines: StoryLine[]): string[] {
  const seen: string[] = []
  for (const l of lines) {
    if (l.kind !== 'line') continue
    const c = l.character || NARRATOR
    if (!seen.includes(c)) seen.push(c)
  }
  return seen.sort((a, b) => (a === NARRATOR ? -1 : b === NARRATOR ? 1 : 0))
}

export interface Placed {
  lineId: string
  character: string
  /** start sample in the mix */
  start: number
  samples: Float32Array
}

export interface Layout {
  sampleRate: number
  length: number
  placed: Placed[]
}

/** Sequential layout: each line after the previous one plus `gapMs` (headings add `chapterGapMs` instead). */
export function layoutStory(lines: StoryLine[], rendered: Map<string, Float32Array>, sampleRate: number, gapMs = 350, chapterGapMs = 1200): Layout {
  const placed: Placed[] = []
  let t = 0
  let first = true
  for (const l of lines) {
    if (l.kind === 'heading') {
      if (!first) t += Math.round((chapterGapMs / 1000) * sampleRate)
      continue
    }
    const s = rendered.get(l.id)
    if (!s) continue
    if (!first) t += Math.round((gapMs / 1000) * sampleRate)
    placed.push({ lineId: l.id, character: l.character || NARRATOR, start: t, samples: s })
    t += s.length
    first = false
  }
  return { sampleRate, length: t, placed }
}

/** Mixdown (all lines) and one full-length stem per character. */
export function buildStems(layout: Layout): { mix: Float32Array; stems: Map<string, Float32Array> } {
  const mix = new Float32Array(layout.length)
  const stems = new Map<string, Float32Array>()
  for (const p of layout.placed) {
    let stem = stems.get(p.character)
    if (!stem) {
      stem = new Float32Array(layout.length)
      stems.set(p.character, stem)
    }
    stem.set(p.samples, p.start)
    for (let i = 0; i < p.samples.length; i++) mix[p.start + i] += p.samples[i]
  }
  // lines never overlap in a sequential layout, but clamp anyway
  for (let i = 0; i < mix.length; i++) mix[i] = Math.max(-1, Math.min(1, mix[i]))
  return { mix, stems }
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const data = samples.length * 2
  const buf = new ArrayBuffer(44 + data)
  const v = new DataView(buf)
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  w(0, 'RIFF')
  v.setUint32(4, 36 + data, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, data, true)
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true)
  }
  return new Uint8Array(buf)
}

/** Decode any audio the browser understands to mono Float32 at `sampleRate`. */
export async function decodeMono(data: ArrayBuffer, sampleRate = 48000): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, sampleRate)
  const buf = await ctx.decodeAudioData(data)
  if (buf.numberOfChannels === 1) return new Float32Array(buf.getChannelData(0))
  const out = new Float32Array(buf.length)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c)
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels
  }
  return out
}

/** Slice [startS, endS) of mono samples. */
export function trimSamples(s: Float32Array, sampleRate: number, startS: number, endS: number): Float32Array {
  const a = Math.max(0, Math.floor(startS * sampleRate))
  const b = Math.min(s.length, Math.ceil(endS * sampleRate))
  return s.slice(a, Math.max(a, b))
}

export const safeFileName = (s: string) => s.replace(/[^\w .-]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'audio'
