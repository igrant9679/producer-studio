// A sound effect from a description, made by this desktop's VoiceStudio (0.5.8: the MOSS-SoundEffect sidecar, POST
// /api/sfx/generate) for the website: relayed like speech (routes/voice.ts `voice.relay` with op 'sfx'), the take is
// brought into the space's library (origin 'voicestudio', synced up by the relay) and the job reports its asset.
import type { AssetRecord } from '@producer/core'
import type { AssetRow } from '../../services/assets'
import { vsJson } from './client'
import { runImport } from './routes'
import { voiceStudio } from './runtime'

type Step = { signal: AbortSignal; progress: (f: number, m?: string) => void; check: () => void }

export async function makeSoundEffect(
  o: { workspaceId: string; userId: string; projectId?: string; prompt: string; duration: number; name?: string },
  jc: Step,
): Promise<{ asset: AssetRecord; row: AssetRow; duration: number }> {
  if (voiceStudio.status().state !== 'running') {
    jc.progress(-1, 'Starting VoiceStudio')
    await voiceStudio.start()
  }
  jc.progress(0.05, 'Making the sound effect')
  // (a cold start loads about 11 GB of weights: VoiceStudio budgets up to 15 minutes)
  const take = await vsJson<{ audio_url: string; duration_s: number }>('/api/sfx/generate', { json: { prompt: o.prompt, duration: Math.min(30, Math.max(1, o.duration)) }, signal: jc.signal, timeoutMs: 20 * 60_000 })
  jc.check()
  const name = o.name || `Sound effect · ${o.prompt.slice(0, 60)}`
  const { asset } = await runImport({ op: 'import', workspaceId: o.workspaceId, projectId: o.projectId, source: take.audio_url, name, kind: 'audio', origin: 'voicestudio' }, o.userId, {
    signal: jc.signal,
    check: jc.check,
    progress: (f, m) => jc.progress(0.6 + f * 0.4, m),
  })
  const { ctx } = await import('../../context')
  const { assets } = await import('../../db/schema')
  const { eq } = await import('drizzle-orm')
  const row = (await ctx().db.select().from(assets).where(eq(assets.id, asset.asset.id)).limit(1))[0]
  if (!row) throw new Error('The sound effect didn’t reach the library')
  return { asset, row, duration: row.meta?.duration ?? take.duration_s }
}
