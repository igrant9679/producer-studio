// VoiceStudio voice profiles ⇄ Producer voice_profiles rows, and speech generation with a profile (desktop only).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { ctx } from '../../context'
import { voiceProfiles, type VoiceConsent } from '../../db/schema'
import { HttpError } from '../../http'
import { newId } from '../../ids'
import { linkInfo } from '../link'
import { vs, vsJson, vsOk } from './client'

export interface VsProfile {
  id: string
  name: string
  kind?: string
  language?: string
  instruct?: string
  ref_text?: string
  audio_url?: string
}

export interface CreateVoiceInput {
  workspaceId: string
  userId: string
  name: string
  kind: 'clone' | 'design'
  engine: string
  language?: string
  gender?: string
  description?: string
  /** clone: the reference recording */
  audio?: { data: Blob; filename: string }
  refText?: string
  /** design: VoiceStudio's tag string and category picks */
  instruct?: string
  vdStates?: Record<string, string>
  seed?: number
  consent: VoiceConsent
}

/** Create the profile in VoiceStudio, then the synced Producer row pointing at it. */
export async function createVoice(input: CreateVoiceInput) {
  const form = new FormData()
  form.set('name', input.name)
  form.set('kind', input.kind)
  form.set('language', input.language || 'Auto')
  if (input.refText) form.set('ref_text', input.refText)
  if (input.instruct) form.set('instruct', input.instruct)
  if (input.seed != null) form.set('seed', String(input.seed))
  if (input.kind === 'clone') {
    if (!input.audio) throw new HttpError(400, 'invalid', 'A cloned voice needs a reference recording')
    form.set('ref_audio', input.audio.data, input.audio.filename)
  } else form.set('vd_states', JSON.stringify(input.vdStates ?? {}))
  // ref_text left blank is auto-transcribed by VoiceStudio's local ASR (can take a while the first time)
  const prof = await vsJson<VsProfile>('/profiles', { method: 'POST', form, timeoutMs: 15 * 60_000 })
  const now = Date.now()
  try {
    const [row] = await ctx()
      .db.insert(voiceProfiles)
      .values({
        id: newId('vp'),
        workspaceId: input.workspaceId,
        name: input.name,
        kind: input.kind,
        engine: input.engine,
        language: input.language && input.language !== 'Auto' ? input.language : null,
        gender: input.gender ?? null,
        description: input.description ?? (input.kind === 'design' ? input.instruct ?? null : null),
        consent: input.consent,
        deviceId: linkInfo()?.deviceId ?? null,
        vsProfileId: prof.id,
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    return row
  } catch (e) {
    await deleteVsProfile(prof.id).catch(() => undefined)
    throw e
  }
}

/** Register a profile that already exists in VoiceStudio (made from a preset, the gallery…) as a Producer voice. */
export async function adoptVoice(input: Omit<CreateVoiceInput, 'audio' | 'refText' | 'vdStates' | 'seed' | 'instruct'> & { vsProfileId: string }) {
  const prof = await vsJson<VsProfile>(`/profiles/${encodeURIComponent(input.vsProfileId)}`)
  const now = Date.now()
  const [row] = await ctx()
    .db.insert(voiceProfiles)
    .values({
      id: newId('vp'),
      workspaceId: input.workspaceId,
      name: input.name || prof.name,
      kind: input.kind,
      engine: input.engine,
      language: input.language && input.language !== 'Auto' ? input.language : prof.language && prof.language !== 'Auto' ? prof.language : null,
      gender: input.gender ?? null,
      description: input.description ?? prof.instruct ?? null,
      consent: input.consent,
      deviceId: linkInfo()?.deviceId ?? null,
      vsProfileId: prof.id,
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row
}

export async function deleteVsProfile(vsProfileId: string) {
  const res = await vs(`/profiles/${encodeURIComponent(vsProfileId)}`, { method: 'DELETE' }).catch(() => null)
  // VoiceStudio not running or already gone: the Producer row still goes; the orphan is harmless
  if (res && !res.ok && res.status !== 404) await vsOk(`/profiles/${encodeURIComponent(vsProfileId)}`, { method: 'DELETE' }).catch(() => undefined)
}

export interface GenerateOptions {
  text: string
  language?: string
  speed?: number
  engine?: string
  effectPreset?: string
  seed?: number
  instruct?: string
  signal?: AbortSignal
}

/** Generate speech with a VoiceStudio profile into `outFile` (WAV). */
export async function generateToFile(vsProfileId: string, outFile: string, o: GenerateOptions): Promise<{ duration: number; seed?: number; historyId?: string; engine?: string }> {
  const form = new FormData()
  form.set('text', o.text)
  form.set('profile_id', vsProfileId)
  form.set('speed', String(Math.min(2, Math.max(0.5, o.speed ?? 1))))
  if (o.language && o.language !== 'Auto') form.set('language', o.language)
  if (o.engine) form.set('engine', o.engine)
  if (o.effectPreset) form.set('effect_preset', o.effectPreset)
  if (o.seed != null) form.set('seed', String(o.seed))
  if (o.instruct) form.set('instruct', o.instruct)
  const res = await vsOk('/generate', { method: 'POST', form, signal: o.signal, timeoutMs: 30 * 60_000 })
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 64) throw new Error('VoiceStudio returned no audio')
  await fsp.writeFile(outFile, buf)
  const duration = Number(res.headers.get('x-audio-duration')) || wavDuration(outFile)
  return { duration, seed: Number(res.headers.get('x-seed')) || undefined, historyId: res.headers.get('x-audio-id') ?? undefined, engine: res.headers.get('x-omnivoice-routing-engine') ?? undefined }
}

/** Duration from a PCM WAV header (fallback when the header is missing). */
function wavDuration(file: string): number {
  try {
    const fd = fs.openSync(file, 'r')
    const h = Buffer.alloc(44)
    fs.readSync(fd, h, 0, 44, 0)
    fs.closeSync(fd)
    const byteRate = h.readUInt32LE(28)
    const size = fs.statSync(file).size - 44
    return byteRate ? size / byteRate : 0
  } catch {
    return 0
  }
}

export async function loadLocalProfile(profileId: string) {
  const row = (await ctx().db.select().from(voiceProfiles).where(eq(voiceProfiles.id, profileId)).limit(1))[0]
  if (!row) throw new HttpError(404, 'not_found', 'Voice not found')
  if (!row.vsProfileId) throw new HttpError(409, 'conflict', `“${row.name}” was created on another computer; generate it there (or from the web app while that computer is online).`)
  return row as typeof row & { vsProfileId: string }
}
