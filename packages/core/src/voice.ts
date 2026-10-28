// Voice Studio scripts (A-20): pause and emphasis markup, the space's pronunciation dictionary, batch voiceovers from
// a CSV, and what a person keeps per space (draft, favourite voices).
//
// Markup, in any script (Voice Studio, Producer narration, the assistant's voiceovers):
//   [pause]  [pause 2s]  [pause 750ms]   a silence (default 0.6 s, at most 10 s)
//   *these words*                         said with emphasis (a little slower and louder)

// GET /api/workspaces/:id/voice-settings              -> VoiceSettings (viewer+)
// PUT /api/workspaces/:id/voice-settings VoiceSettings -> VoiceSettings (editor+)
// GET /api/workspaces/:id/voice-studio                -> VoiceStudioPrefs (this person's draft and favourites)
// PUT /api/workspaces/:id/voice-studio Partial<VoiceStudioPrefs> -> VoiceStudioPrefs
// POST /api/ai/tts/preview {workspaceId, text, voice, speed?} -> audio/wav (not saved; built-in voices; ≤ 300 chars)

export interface Pronunciation {
  /** The word or phrase as written ("Kubernetes", "SQL"). */
  word: string
  /** How to say it ("koo-ber-net-eez", "sequel"). */
  say: string
}

export interface VoiceSettings {
  pronunciations: Pronunciation[]
}

export interface VoiceDraft {
  text: string
  name: string
  speed: number
  voice?: string
}

export interface VoiceStudioPrefs {
  draft?: VoiceDraft
  favourites: string[]
}

export const PRONUNCIATIONS_MAX = 200
export const PREVIEW_CHARS = 300
export const PAUSE_DEFAULT = 0.6
export const PAUSE_MAX = 10

export type ScriptPart = { kind: 'say'; text: string; emphasis?: boolean } | { kind: 'pause'; seconds: number }

const PAUSE = /\[pause(?:\s+(\d+(?:\.\d+)?)\s*(ms|s)?)?\]/gi

/** The script as what is said and the silences between: emphasis runs and pauses split it, empty bits are dropped. */
export function parseScript(text: string): ScriptPart[] {
  const out: ScriptPart[] = []
  const say = (t: string, emphasis = false) => {
    const clean = t.replace(/\s+/g, ' ').trim()
    if (!clean) return
    const last = out[out.length - 1]
    if (last?.kind === 'say' && !!last.emphasis === emphasis) last.text = `${last.text} ${clean}`
    else out.push(emphasis ? { kind: 'say', text: clean, emphasis: true } : { kind: 'say', text: clean })
  }
  let at = 0
  for (const m of text.matchAll(PAUSE)) {
    sayWithEmphasis(text.slice(at, m.index), say)
    const n = m[1] ? Number(m[1]) : PAUSE_DEFAULT
    const seconds = Math.min(PAUSE_MAX, Math.max(0.05, m[2]?.toLowerCase() === 'ms' ? n / 1000 : n))
    const last = out[out.length - 1]
    if (last?.kind === 'pause') last.seconds = Math.min(PAUSE_MAX, last.seconds + seconds)
    else out.push({ kind: 'pause', seconds })
    at = (m.index ?? 0) + m[0].length
  }
  sayWithEmphasis(text.slice(at), say)
  return out
}

function sayWithEmphasis(chunk: string, say: (t: string, emphasis?: boolean) => void) {
  let at = 0
  for (const m of chunk.matchAll(/\*([^*\n]+)\*/g)) {
    say(chunk.slice(at, m.index))
    say(m[1], true)
    at = (m.index ?? 0) + m[0].length
  }
  say(chunk.slice(at))
}

/** Whether a script uses any markup (a plain one is voiced in one go). */
export function hasMarkup(text: string): boolean {
  return new RegExp(PAUSE.source, 'i').test(text) || /\*[^*\n]+\*/.test(text)
}

/** The script with the markup taken out: what a voice that can't pause or stress says. */
export function plainScript(text: string): string {
  return parseScript(text)
    .map((p) => (p.kind === 'say' ? p.text : p.seconds >= 1 ? '…' : ','))
    .join(' ')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .replace(/^[,…]\s*/, '')
    .trim()
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Say the dictionary's words its way: whole words, any case, longest first. */
export function applyPronunciations(text: string, dict: Pronunciation[]): string {
  const list = dict.filter((p) => p.word.trim() && p.say.trim()).sort((a, b) => b.word.length - a.word.length)
  if (!list.length) return text
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${list.map((p) => escape(p.word.trim())).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
  const by = new Map(list.map((p) => [p.word.trim().toLowerCase(), p.say.trim()]))
  return text.replace(re, (m) => by.get(m.toLowerCase()) ?? m)
}

/** About how long a script takes to say at `speed`: 2.5 words a second, plus its pauses. */
export function scriptSeconds(text: string, speed = 1): number {
  let s = 0
  for (const p of parseScript(text)) s += p.kind === 'pause' ? p.seconds : p.text.split(/\s+/).filter(Boolean).length / 2.5 / Math.max(0.5, speed)
  return Math.round(s * 10) / 10
}

// ---------- batch voiceovers from a CSV ----------

export interface CsvVoiceRow {
  /** 1-based line in the file. */
  line: number
  text: string
  voice?: string
  name?: string
  speed?: number
  error?: string
}

export const BATCH_MAX_ROWS = 50

/** RFC 4180-ish CSV: quoted fields with "" escapes and newlines, comma or semicolon separated. */
export function parseCsv(src: string): string[][] {
  const text = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && !field) quoted = true
    else if (c === sep) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim()))
}

/**
 * Voiceovers from a CSV: a `text` (or `script`) column, optional `voice`, `name`, `speed`; without a header row the
 * first column is the text. `voiceIds` checks the voices; rows past BATCH_MAX_ROWS are refused.
 */
export function parseVoiceCsv(src: string, voiceIds: Set<string>, maxChars = 5000): CsvVoiceRow[] {
  const rows = parseCsv(src)
  if (!rows.length) return []
  const head = rows[0].map((h) => h.trim().toLowerCase())
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h))
  const hasHeader = col('text', 'script') >= 0
  const ti = hasHeader ? col('text', 'script') : 0
  const vi = hasHeader ? col('voice') : -1
  const ni = hasHeader ? col('name', 'title') : -1
  const si = hasHeader ? col('speed') : -1
  const body = hasHeader ? rows.slice(1) : rows
  return body.map((r, i) => {
    const line = i + (hasHeader ? 2 : 1)
    const out: CsvVoiceRow = { line, text: (r[ti] ?? '').trim() }
    const voice = vi >= 0 ? r[vi]?.trim() : ''
    const name = ni >= 0 ? r[ni]?.trim() : ''
    const speed = si >= 0 && r[si]?.trim() ? Number(r[si].trim()) : undefined
    if (voice) out.voice = voice
    if (name) out.name = name
    if (speed !== undefined) out.speed = speed
    if (!out.text) out.error = 'No text'
    else if (out.text.length > maxChars) out.error = `Longer than ${maxChars} characters`
    else if (voice && !voiceIds.has(voice)) out.error = `Unknown voice “${voice}”`
    else if (speed !== undefined && !(speed >= 0.5 && speed <= 2)) out.error = 'Speed must be 0.5 to 2'
    else if (i >= BATCH_MAX_ROWS) out.error = `At most ${BATCH_MAX_ROWS} voiceovers at a time`
    return out
  })
}
