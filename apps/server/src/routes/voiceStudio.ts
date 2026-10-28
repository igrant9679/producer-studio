// Voice Studio settings (A-20), mounted at /api/workspaces: the space's pronunciation dictionary, each person's draft
// and favourite voices in a space, and a quick preview of a line in a voice (for side-by-side comparison).
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import * as z from 'zod/v4'
import { PREVIEW_CHARS, PRONUNCIATIONS_MAX, VOICES, isProfileVoice, type Pronunciation, type VoiceSettings, type VoiceStudioPrefs } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { HttpError, body, requireRole } from '../http'
import { speakScript } from '../ai/voiceScript'
import { tmpDir } from '../services/assets'
import { getMemberSettings, getSpaceSettings, patchMemberSettings, patchSpaceSettings } from '../services/settings'

export const voiceStudioRoutes = new Hono<AppEnv>()

const PronunciationSchema = z.object({ word: z.string().trim().min(1).max(80), say: z.string().trim().min(1).max(160) })

async function voiceSettings(workspaceId: string): Promise<VoiceSettings> {
  const list = (await getSpaceSettings(workspaceId)).pronunciations
  return { pronunciations: Array.isArray(list) ? (list as Pronunciation[]) : [] }
}

voiceStudioRoutes.get('/:id/voice-settings', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  return c.json(await voiceSettings(id))
})

voiceStudioRoutes.put('/:id/voice-settings', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'editor')
  const b = await body(c, z.object({ pronunciations: z.array(PronunciationSchema).max(PRONUNCIATIONS_MAX) }))
  // one entry per word (the last one wins)
  const by = new Map<string, Pronunciation>()
  for (const p of b.pronunciations) by.set(p.word.toLowerCase(), p)
  await patchSpaceSettings(id, { pronunciations: [...by.values()] })
  return c.json(await voiceSettings(id))
})

const DraftSchema = z.object({ text: z.string().max(10000), name: z.string().max(200), speed: z.number().min(0.5).max(2), voice: z.string().max(80).optional() })

async function prefs(userId: string, workspaceId: string): Promise<VoiceStudioPrefs> {
  const v = ((await getMemberSettings(userId, workspaceId)).voice ?? {}) as Partial<VoiceStudioPrefs>
  return { ...(v.draft ? { draft: v.draft } : {}), favourites: Array.isArray(v.favourites) ? v.favourites : [] }
}

voiceStudioRoutes.get('/:id/voice-studio', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  return c.json(await prefs(u.id, id))
})

/** This person's draft (null clears it) and favourite voices in this space. */
voiceStudioRoutes.put('/:id/voice-studio', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  const b = await body(c, z.object({ draft: DraftSchema.nullable().optional(), favourites: z.array(z.string().min(1).max(80)).max(100).optional() }))
  const cur = await prefs(u.id, id)
  const next: VoiceStudioPrefs = { ...cur }
  if (b.draft === null) delete next.draft
  else if (b.draft) next.draft = b.draft
  if (b.favourites) next.favourites = [...new Set(b.favourites)]
  await patchMemberSettings(u.id, id, { voice: next })
  return c.json(next)
})

/**
 * A line in a voice, not saved anywhere: Voice Studio plays the same line in several voices side by side. Built-in
 * voices only (cloned and designed ones are made by the desktop that holds them).
 */
voiceStudioRoutes.post('/:id/voice-preview', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'editor')
  const b = await body(c, z.object({ text: z.string().trim().min(1).max(PREVIEW_CHARS), voice: z.string().max(80), speed: z.number().min(0.5).max(2).optional() }))
  if (isProfileVoice(b.voice)) throw new HttpError(400, 'invalid', 'Compare cloned and designed voices by generating a voiceover with each')
  if (!VOICES.some((v) => v.id === b.voice)) throw new HttpError(400, 'invalid', 'Unknown voice')
  const work = tmpDir('vpreview')
  try {
    const out = path.join(work, 'preview.wav')
    await speakScript(b.text, out, { voice: b.voice, speed: b.speed ?? 1, workspaceId: id, signal: c.req.raw.signal })
    const buf = fs.readFileSync(out)
    return new Response(buf, { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(buf.length), 'Cache-Control': 'no-store' } })
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
})
