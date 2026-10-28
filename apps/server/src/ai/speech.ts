// Transcription and TTS as reusable steps (used by their jobs, by produce.assemble and by the assistant).
import fs from 'node:fs'
import path from 'node:path'
import { isProfileVoice, type AssetRecord, type Transcript } from '@producer/core'
import { assetRecord } from '../dto'
import type { JobContext } from '../jobs/worker'
import { processAsset } from '../media/process'
import { type AssetRow, createAssetFromFile, loadAsset, localSource, mergeAssetMeta, tmpDir } from '../services/assets'
import { silentTranscript, transcribeFile } from './whisper'
import { validVoice } from './tts'
import { speakScript } from './voiceScript'
import { synthesizeProfileToAsset } from '../services/voice'

type Step = Pick<JobContext, 'signal' | 'progress' | 'check'>

export async function transcribeAsset(assetId: string, language: string | undefined, jc: Step): Promise<{ asset: AssetRow; transcript: Transcript }> {
  const row = await loadAsset(assetId)
  if (row.kind === 'image') throw new Error('Images have no speech to transcribe')
  if (row.meta?.hasAudio === false) {
    // processing found no sound track (a screen recording without a microphone): nothing to hear
    const transcript = silentTranscript(language)
    const asset = await mergeAssetMeta(assetId, { transcript })
    jc.progress(1, 'No sound to transcribe')
    return { asset, transcript }
  }
  const work = tmpDir(`stt-${assetId}`)
  try {
    jc.progress(0.02, 'Extracting audio')
    // the AAC extract is smaller than the source video when we have it
    const src = await localSource(row, work, row.audioKey ?? row.sourceKey)
    jc.check()
    jc.progress(0.08, 'Transcribing')
    const transcript = await transcribeFile(src, { language, workDir: work, signal: jc.signal, progress: (f) => jc.progress(0.08 + f * 0.9, 'Transcribing') })
    const asset = await mergeAssetMeta(assetId, { transcript })
    jc.progress(1, `${transcript.segments.length} segments`)
    return { asset, transcript }
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}

/** Ensure an asset has a transcript (transcribe if missing). */
export async function ensureTranscript(assetId: string, jc: Step): Promise<Transcript> {
  const row = await loadAsset(assetId)
  if (row.meta?.transcript) return row.meta.transcript
  return (await transcribeAsset(assetId, undefined, jc)).transcript
}

export interface TtsInput {
  workspaceId: string
  userId: string
  projectId?: string | null
  text: string
  voice: string
  speed?: number
  name?: string
  /** The job making this voice (recorded on the clip, so a crash can't leave it "processing" for good). */
  jobId?: string
}

/** Synthesize narration → WAV → audio asset (origin 'tts'), processed inline for waveform. */
export async function synthesizeToAsset(input: TtsInput, jc: Step): Promise<{ asset: AssetRecord; row: AssetRow; duration: number }> {
  // cloned / designed voices run in VoiceStudio (desktop) or are relayed to the desktop that owns them (cloud)
  if (isProfileVoice(input.voice)) return synthesizeProfileToAsset(input, jc)
  const work = tmpDir('tts')
  try {
    const voice = validVoice(input.voice)
    const speed = Math.min(2, Math.max(0.5, input.speed ?? 1))
    jc.progress(0.05, 'Generating voice')
    const out = path.join(work, 'voice.wav')
    // a fresh server may still be fetching the voice model: the job shows its download
    // the space's pronunciations, pauses and emphasis (A-20); the asset keeps the script as written
    const r = await speakScript(input.text, out, { voice, speed, workspaceId: input.workspaceId, signal: jc.signal, progress: (f, m) => jc.progress(0.05 + 0.6 * f, m) })
    jc.check()
    const name = input.name || `Voiceover · ${input.text.replace(/\s+/g, ' ').slice(0, 40)}${input.text.length > 40 ? '…' : ''}`
    const created = await createAssetFromFile({
      workspaceId: input.workspaceId,
      userId: input.userId,
      projectId: input.projectId,
      filePath: out,
      name,
      mime: 'audio/wav',
      kind: 'audio',
      origin: 'tts',
      meta: { tts: { text: input.text, voice, speed }, duration: Math.round(r.duration * 1000) / 1000, ...(input.jobId ? { jobId: input.jobId } : {}) },
    })
    jc.progress(0.8, 'Analysing audio')
    const row = await processAsset(created.id, { signal: jc.signal, check: jc.check, progress: () => undefined })
    jc.progress(1, 'Voice ready')
    return { asset: assetRecord(row), row, duration: row.meta?.duration ?? r.duration }
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}
