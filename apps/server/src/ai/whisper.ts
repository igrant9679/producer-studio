// Speech-to-text with the whisper.cpp CLI (word timings from the full JSON token offsets).
import fs from 'node:fs'
import path from 'node:path'
import type { Transcript, TranscriptSegment } from '@producer/core'
import { ctx } from '../context'
import { ffmpeg, runOk } from '../media/proc'
import { HttpError } from '../http'

interface WhisperToken {
  text: string
  offsets: { from: number; to: number }
}
interface WhisperSegment {
  text: string
  offsets: { from: number; to: number }
  tokens?: WhisperToken[]
}

export function whisperAvailable(): boolean {
  const { whisperCli, whisperModel } = ctx().config
  return Boolean(whisperCli && whisperModel && fs.existsSync(whisperCli) && fs.existsSync(whisperModel))
}

/** Map whisper.cpp `-ojf` output to the core Transcript shape. */
export function mapWhisperJson(data: { transcription?: WhisperSegment[]; result?: { language?: string } }, language: string): Transcript {
  const segments: TranscriptSegment[] = []
  for (const t of data.transcription ?? []) {
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
    segments.push({ start: t.offsets.from / 1000, end: t.offsets.to / 1000, text, words: clean })
  }
  return { language: data.result?.language || language, engine: 'whisper.cpp', segments }
}

export async function transcribeFile(file: string, opts: { language?: string; workDir: string; signal?: AbortSignal; progress?: (f: number) => void }): Promise<Transcript> {
  const cfg = ctx().config
  if (!whisperAvailable()) throw new HttpError(503, 'server', 'Transcription is not configured on this server (set WHISPER_CLI and WHISPER_MODEL)')
  const lang = opts.language || 'en'
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
  return mapWhisperJson(json, lang)
}
