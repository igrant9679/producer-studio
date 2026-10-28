// Speech-to-text with the whisper.cpp CLI (word timings from the full JSON token offsets).
import fs from 'node:fs'
import path from 'node:path'
import type { Transcript, TranscriptSegment } from '@producer/core'
import { ctx } from '../context'
import { ffmpeg, runOk } from '../media/proc'
import { probe } from '../media/process'
import { HttpError, invalid } from '../http'

interface WhisperToken {
  text: string
  offsets: { from: number; to: number }
}
interface WhisperSegment {
  text: string
  offsets: { from: number; to: number }
  tokens?: WhisperToken[]
  /** `-di` (stereo diarization): "0", "1", or "?" when it can't tell. */
  speaker?: string
  /** `-tdrz` (a tinydiarize model): the next segment is another speaker's. */
  speaker_turn_next?: boolean
}

export function whisperAvailable(): boolean {
  const { whisperCli, whisperModel } = ctx().config
  return Boolean(whisperCli && whisperModel && fs.existsSync(whisperCli) && fs.existsSync(whisperModel))
}

/** whisper.cpp's `-l` codes. */
const WHISPER_LANGUAGES = new Set(
  'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue'.split(' '),
)

/** English-only models (ggml-small.en.bin, ggml-base.en-q5_1.bin) hear every language as English: they ignore `-l`. */
export function whisperMultilingual(model = ctx().config.whisperModel ?? ''): boolean {
  return !/\.en(?:[._-]|$)/i.test(path.basename(model).replace(/\.bin$/i, ''))
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/**
 * The `-l` value for a requested language ("fr", "pt-BR", "auto" or nothing). Nothing asked for is auto-detect on a
 * multilingual model and English on an English-only one; a language the model can't hear is refused in words, not
 * transcribed as English gibberish.
 */
export function whisperLanguage(requested: string | undefined, model?: string): string {
  const multi = whisperMultilingual(model)
  const code = (requested ?? '').trim().toLowerCase().split(/[-_]/)[0]
  if (!code || code === 'auto') return multi ? 'auto' : 'en'
  if (!WHISPER_LANGUAGES.has(code)) throw invalid(`Transcription doesn't support the language "${requested}".`)
  if (code !== 'en' && !multi)
    throw invalid(
      `Transcription on this server only understands English, so it can't transcribe ${languageName(code)}. Transcribe in English, or install a multilingual Whisper model on the server (WHISPER_MODEL, e.g. ggml-small.bin).`,
    )
  return code
}

/** Map whisper.cpp `-ojf` output to the core Transcript shape. */
export function mapWhisperJson(data: { transcription?: WhisperSegment[]; result?: { language?: string } }, language: string): Transcript {
  const segments: TranscriptSegment[] = []
  // speakers where whisper gives them: a channel per speaker, or turns (two voices taking turns)
  const turns = (data.transcription ?? []).some((t) => t.speaker_turn_next)
  let turn = 0
  for (const t of data.transcription ?? []) {
    const who = t.speaker !== undefined ? (/^\d+$/.test(t.speaker.trim()) ? `Speaker ${+t.speaker.trim() + 1}` : undefined) : turns ? `Speaker ${(turn % 2) + 1}` : undefined
    if (t.speaker_turn_next) turn++
    const text = t.text.trim()
    if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) continue
    const words: Array<{ w: string; start: number; end: number }> = []
    for (const tok of t.tokens ?? []) {
      if (/^\[_.*_?\]$/.test(tok.text.trim()) || /^\[_/.test(tok.text.trim())) continue
      const from = tok.offsets.from / 1000
      const to = tok.offsets.to / 1000
      if (tok.text.startsWith(' ') || !words.length) {
        const w = tok.text.trim()
        if (w) words.push({ w, start: from, end: to })
      } else {
        const last = words[words.length - 1]
        last.w += tok.text.trim()
        last.end = Math.max(last.end, to)
      }
    }
    const clean = words
      .filter((w) => w.w && !/^[[(].*[\])]$/.test(w.w))
      .map((w) => ({ w: w.w, start: Math.round(w.start * 1000) / 1000, end: Math.round(Math.max(w.end, w.start + 0.02) * 1000) / 1000 }))
    segments.push({ start: t.offsets.from / 1000, end: t.offsets.to / 1000, text, words: clean, ...(who ? { speaker: who } : {}) })
  }
  return { language: data.result?.language || language, engine: 'whisper.cpp', segments }
}

export async function transcribeFile(file: string, opts: { language?: string; workDir: string; signal?: AbortSignal; progress?: (f: number) => void }): Promise<Transcript> {
  const cfg = ctx().config
  if (!whisperAvailable()) throw new HttpError(503, 'server', 'Transcription is not configured on this server (set WHISPER_CLI and WHISPER_MODEL)')
  const lang = whisperLanguage(opts.language, cfg.whisperModel)
  // a screen recording without a microphone has nothing to hear (ffmpeg would fail to extract audio from it)
  const info = await probe(file, opts.signal).catch(() => undefined)
  if (info && !info.hasAudio) return silentTranscript(lang)
  const wav = path.join(opts.workDir, 'speech-16k.wav')
  await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal: opts.signal })
  const base = path.join(opts.workDir, 'whisper')
  await runOk(
    cfg.whisperCli!,
    ['-m', cfg.whisperModel!, '-f', wav, '-l', lang, '-t', String(cfg.whisperThreads), '-ojf', '-of', base, '-pp'],
    {
      signal: opts.signal,
      cwd: path.dirname(cfg.whisperCli!),
      onStderr: (s) => {
        const m = s.match(/progress\s*=\s*(\d+)%/g)
        if (m) opts.progress?.(Number(m[m.length - 1].replace(/\D/g, '')) / 100)
      },
    },
    'whisper.cpp',
  )
  const json = JSON.parse(fs.readFileSync(base + '.json', 'utf8'))
  return mapWhisperJson(json, lang === 'auto' ? 'und' : lang)
}

/** The transcript of a clip with no sound: no speech, nothing to fail on. */
export function silentTranscript(language = 'en'): Transcript {
  return { language: language === 'auto' ? 'und' : language, engine: 'whisper.cpp', segments: [] }
}
