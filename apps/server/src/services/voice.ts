// Speech with VoiceStudio profile voices: generated locally on the desktop that owns the voice, or (cloud) relayed to it
// as a `voice.relay` job that this process waits on.
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { profileIdOf, type AssetRecord } from '@producer/core'
import { ctx } from '../context'
import { assets, devices, memberships, voiceProfiles } from '../db/schema'
import { assetRecord } from '../dto'
import { HttpError } from '../http'
import { cancelJob, enqueue, getJob, type JobRow } from '../jobs/queue'
import type { JobContext } from '../jobs/worker'
import { processAsset } from '../media/process'
import { type AssetRow, createAssetFromFile, tmpDir } from './assets'
import type { RelayInput } from '../routes/voice'
import { and } from 'drizzle-orm'

type Step = Pick<JobContext, 'signal' | 'progress' | 'check'>

export interface ProfileTtsInput {
  workspaceId: string
  userId: string
  projectId?: string | null
  text: string
  voice: string
  speed?: number
  name?: string
}

const autoName = (text: string) => `Voiceover · ${text.replace(/\s+/g, ' ').slice(0, 40)}${text.length > 40 ? '…' : ''}`

async function profileRow(voice: string, workspaceId: string) {
  const row = (await ctx().db.select().from(voiceProfiles).where(eq(voiceProfiles.id, profileIdOf(voice))).limit(1))[0]
  if (!row || row.workspaceId !== workspaceId) throw new HttpError(404, 'not_found', 'That voice isn’t in this space')
  return row
}

/** Cloud: validate and enqueue a relay job for the desktop that owns the voice. */
export async function enqueueRelay(input: ProfileTtsInput): Promise<JobRow> {
  const row = await profileRow(input.voice, input.workspaceId)
  if (!row.deviceId) throw new HttpError(409, 'conflict', `“${row.name}” was made on a desktop that wasn’t linked; link it and sync, then try again.`)
  const dev = (await ctx().db.select().from(devices).where(eq(devices.id, row.deviceId)).limit(1))[0]
  if (!dev) throw new HttpError(409, 'conflict', `The desktop that holds “${row.name}” is no longer linked to this account.`)
  // the device's owner must still be in the space
  const member = await ctx().db.select().from(memberships).where(and(eq(memberships.workspaceId, row.workspaceId), eq(memberships.userId, dev.userId))).limit(1)
  if (!member.length) throw new HttpError(409, 'conflict', `The owner of “${row.name}” is no longer in this space.`)
  const relay: RelayInput = { profileId: row.id, deviceId: row.deviceId, text: input.text, speed: input.speed, name: input.name || `${autoName(input.text)} — ${row.name}`, language: row.language ?? undefined }
  return enqueue('voice.relay', { ...relay, workspaceId: input.workspaceId, projectId: input.projectId ?? undefined }, { workspaceId: input.workspaceId, userId: input.userId, projectId: input.projectId, message: `Waiting for ${dev.name}` })
}

/** Cloud: enqueue a relay job and wait for the desktop to finish it (used inside other jobs: Producer AI, assistant). */
async function relayAndWait(input: ProfileTtsInput, jc: Step): Promise<{ asset: AssetRecord; row: AssetRow; duration: number }> {
  const job = await enqueueRelay(input)
  const deadline = Date.now() + 30 * 60_000
  try {
    for (;;) {
      jc.check()
      const j = await getJob(job.id)
      if (!j) throw new Error('The voice job disappeared')
      if (j.status === 'done') {
        const assetId = (j.result as { asset?: AssetRecord } | null)?.asset?.asset.id
        const row = assetId ? (await ctx().db.select().from(assets).where(eq(assets.id, assetId)).limit(1))[0] : undefined
        if (!row) throw new Error('The desktop finished but the audio didn’t arrive')
        return { asset: assetRecord(row), row, duration: row.meta?.duration ?? 0 }
      }
      if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.error || 'Voice generation failed on the desktop')
      jc.progress(j.status === 'running' ? Math.max(0.05, j.progress) : -1, j.message)
      if (Date.now() > deadline) throw new Error('The desktop that holds this voice didn’t respond in time')
      await new Promise((r) => setTimeout(r, 1500))
    }
  } catch (e) {
    await cancelJob(job.id).catch(() => undefined)
    throw e
  }
}

/** Synthesize with a profile voice → audio asset (origin 'tts'). */
export async function synthesizeProfileToAsset(input: ProfileTtsInput, jc: Step, assetId?: string): Promise<{ asset: AssetRecord; row: AssetRow; duration: number }> {
  if (ctx().config.mode !== 'desktop') return relayAndWait(input, jc)
  const { loadLocalProfile, generateToFile } = await import('../desktop/voicestudio/profiles')
  const { voiceStudio } = await import('../desktop/voicestudio/runtime')
  const prof = await loadLocalProfile(profileIdOf(input.voice))
  if (voiceStudio.status().state !== 'running') {
    jc.progress(-1, 'Starting VoiceStudio')
    await voiceStudio.start()
  }
  const work = tmpDir('vs-tts')
  try {
    jc.progress(0.05, `Generating with ${prof.name}`)
    const out = path.join(work, 'voice.wav')
    const r = await generateToFile(prof.vsProfileId, out, { text: input.text, speed: input.speed, language: prof.language ?? undefined, engine: prof.engine || undefined, signal: jc.signal })
    jc.check()
    const created = await createAssetFromFile({
      ...(assetId ? { id: assetId } : {}),
      workspaceId: input.workspaceId,
      userId: input.userId,
      projectId: input.projectId,
      filePath: out,
      name: input.name || `${autoName(input.text)} — ${prof.name}`,
      mime: 'audio/wav',
      kind: 'audio',
      origin: 'tts',
      meta: { tts: { text: input.text, voice: input.voice, speed: input.speed ?? 1 }, duration: Math.round(r.duration * 1000) / 1000 },
    })
    jc.progress(0.8, 'Analysing audio')
    const row = await processAsset(created.id, { signal: jc.signal, check: jc.check, progress: () => undefined })
    jc.progress(1, 'Voice ready')
    return { asset: assetRecord(row), row, duration: row.meta?.duration ?? r.duration }
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}
