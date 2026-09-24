import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import * as z from 'zod/v4'
import { VOICES, type AssistantRequest, type Project } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { jobDto } from '../dto'
import { eq } from 'drizzle-orm'
import { memberships, workspaces } from '../db/schema'
import { HttpError, body, notFound, requireRole } from '../http'
import { enqueue } from '../jobs/queue'
import { inlineContext } from '../jobs/worker'
import { log } from '../log'
import { loadAsset } from '../services/assets'
import { loadProjectRow } from '../services/projects'
import { runAssistant } from '../ai/assistant'
import { requireProvider } from '../ai/provider'
import { ensureTranscript, synthesizeToAsset } from '../ai/speech'
import { tts, validVoice } from '../ai/tts'
import { whisperAvailable } from '../ai/whisper'

export const aiRoutes = new Hono<AppEnv>()

aiRoutes.post('/transcribe', async (c) => {
  const u = requireUser(c)
  const b = await body(c, z.object({ assetId: z.string().min(1), language: z.string().max(10).optional() }))
  const a = await loadAsset(b.assetId)
  await requireRole(u.id, a.workspaceId, 'editor')
  if (!whisperAvailable()) throw new HttpError(503, 'server', 'Transcription is not configured on this server')
  const j = await enqueue('ai.transcribe', b, { workspaceId: a.workspaceId, userId: u.id, projectId: a.projectId, message: `Transcribing ${a.name}` })
  return c.json(jobDto(j))
})

aiRoutes.post('/tts', async (c) => {
  const u = requireUser(c)
  const b = await body(c, z.object({ workspaceId: z.string().min(1), projectId: z.string().optional(), text: z.string().trim().min(1).max(10000), voice: z.string().max(40), speed: z.number().min(0.5).max(2).optional(), name: z.string().max(200).optional() }))
  await requireRole(u.id, b.workspaceId, 'editor')
  const j = await enqueue('ai.tts', { ...b, voice: validVoice(b.voice) }, { workspaceId: b.workspaceId, userId: u.id, projectId: b.projectId, message: 'Generating voice' })
  return c.json(jobDto(j))
})

aiRoutes.get('/voices', (c) => {
  requireUser(c)
  return c.json(VOICES)
})

const sampleJobs = new Map<string, Promise<string>>()
const SAMPLE_LINE: Record<string, string> = { a: 'Hi, I’m your narrator. Let’s turn this recording into something people want to watch.', b: 'Hello, I’ll be narrating your video today. Shall we make something worth watching?' }

aiRoutes.get('/voices/:id/sample', async (c) => {
  requireUser(c)
  const id = c.req.param('id')
  const v = VOICES.find((x) => x.id === id)
  if (!v) throw notFound('Unknown voice')
  const dir = path.join(ctx().config.dataDir, 'voice-samples')
  const file = path.join(dir, `${id}.wav`)
  if (!fs.existsSync(file)) {
    let p = sampleJobs.get(id)
    if (!p) {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp.wav`
      p = tts
        .synthesize(`${SAMPLE_LINE[id[0]] ?? SAMPLE_LINE.a}`, tmp, { voice: id, speed: 1 })
        .then(() => {
          fs.renameSync(tmp, file)
          return file
        })
        .finally(() => sampleJobs.delete(id))
      sampleJobs.set(id, p)
    }
    await p
  }
  const buf = fs.readFileSync(file)
  return new Response(buf, { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(buf.length), 'Cache-Control': 'private, max-age=86400' } })
})

/** Workspace whose AI settings apply to the writer: the requested one (editor+), else the user's personal workspace. */
async function writerScope(userId: string, workspaceId: string | undefined): Promise<string | undefined> {
  if (ctx().config.mode === 'desktop') return undefined
  if (workspaceId) {
    await requireRole(userId, workspaceId, 'editor')
    return workspaceId
  }
  const rows = await ctx()
    .db.select({ id: workspaces.id, personal: workspaces.personal })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
  return (rows.find((r) => r.personal) ?? rows[0])?.id
}

aiRoutes.post('/write', async (c) => {
  const u = requireUser(c)
  const b = await body(c, z.object({ kind: z.enum(['voiceover', 'script', 'headline', 'caption', 'rewrite']), prompt: z.string().min(1).max(20000), context: z.string().max(50000).optional(), maxWords: z.number().int().min(1).max(5000).optional(), workspaceId: z.string().max(100).optional() }))
  const provider = await requireProvider(await writerScope(u.id, b.workspaceId), 'writer')
  return streamSSE(c, async (stream) => {
    const ac = new AbortController()
    stream.onAbort(() => ac.abort())
    try {
      const text = await provider.write(b, (d) => void stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: d }) }), ac.signal)
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ text }) })
    } catch (err) {
      if (!ac.signal.aborted) {
        const e = err instanceof HttpError ? { error: err.message, code: err.code } : { error: 'AI request failed', code: 'server' }
        if (!(err instanceof HttpError)) log.error('ai write failed', { err })
        await stream.writeSSE({ event: 'error', data: JSON.stringify(e) })
      }
    }
  })
})

const BriefSchema = z.object({
  title: z.string().max(200),
  audience: z.string().max(500).default(''),
  goal: z.string().max(1000).default(''),
  tone: z.string().max(200).default('warm'),
  template: z.string().max(60).default('studio-dark'),
  voice: z.string().max(40).default('af_heart'),
  aspect: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
  notes: z.string().max(4000).optional(),
})

aiRoutes.post('/produce/script', async (c) => {
  const u = requireUser(c)
  const b = await body(c, z.object({ projectId: z.string().min(1), assetIds: z.array(z.string()).min(1).max(20), brief: BriefSchema }))
  const row = await loadProjectRow(b.projectId)
  await requireRole(u.id, row.workspaceId, 'editor')
  await requireProvider(row.workspaceId, 'script')
  const j = await enqueue('ai.produce.script', { ...b, brief: { ...b.brief, voice: validVoice(b.brief.voice) } }, { workspaceId: row.workspaceId, userId: u.id, projectId: row.id, message: 'Writing script' })
  return c.json(jobDto(j))
})

const SceneSchema = z.object({
  id: z.string().min(1).max(20),
  title: z.string().max(200),
  headline: z.string().max(300),
  narration: z.string().min(1).max(5000),
  footage: z.array(z.object({ assetId: z.string(), start: z.number().min(0), end: z.number().min(0) })).max(20),
  visuals: z.string().max(2000).optional(),
  voice: z.object({ assetId: z.string(), duration: z.number() }).optional(),
})

aiRoutes.post('/produce/assemble', async (c) => {
  const u = requireUser(c)
  const b = await body(c, z.object({ projectId: z.string().min(1), scenes: z.array(SceneSchema).min(1).max(40) }))
  const row = await loadProjectRow(b.projectId)
  await requireRole(u.id, row.workspaceId, 'editor')
  const j = await enqueue('ai.produce.assemble', b, { workspaceId: row.workspaceId, userId: u.id, projectId: row.id, message: 'Assembling' })
  return c.json(jobDto(j))
})

aiRoutes.post('/assistant', async (c) => {
  const u = requireUser(c)
  const b = await body(
    c,
    z.object({
      projectId: z.string().min(1),
      project: z.looseObject({ id: z.string(), tracks: z.array(z.unknown()), assets: z.record(z.string(), z.unknown()) }),
      playhead: z.number().min(0).default(0),
      selection: z.array(z.string()).default([]),
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(20000) })).min(1).max(100),
    }),
  )
  const row = await loadProjectRow(b.projectId)
  await requireRole(u.id, row.workspaceId, 'editor')
  const provider = await requireProvider(row.workspaceId, 'assistant')
  const wsId = row.workspaceId
  const req = b as unknown as AssistantRequest
  return streamSSE(c, async (stream) => {
    const ac = new AbortController()
    stream.onAbort(() => ac.abort())
    const step = inlineContext({ id: 'assistant', kind: 'ai.transcribe', workspaceId: wsId, userId: u.id, projectId: row.id, input: {} }, ac.signal)
    const env = {
      transcribe: async (assetId: string) => {
        const a = await loadAsset(assetId)
        if (a.workspaceId !== wsId) throw notFound('Asset not found')
        return ensureTranscript(assetId, step)
      },
      tts: async (text: string, voice: string, speed: number) => {
        const r = await synthesizeToAsset({ workspaceId: wsId, userId: u.id, projectId: row.id, text, voice, speed }, step)
        return { asset: r.asset.asset, duration: r.duration }
      },
    }
    try {
      const result = await runAssistant(
        provider,
        { ...req, project: req.project as Project },
        env,
        {
          text: (d) => void stream.writeSSE({ event: 'text', data: JSON.stringify({ delta: d }) }),
          tool: (name, summary) => void stream.writeSSE({ event: 'tool', data: JSON.stringify({ name, summary }) }),
        },
        ac.signal,
      )
      await stream.writeSSE({ event: 'done', data: JSON.stringify(result) })
    } catch (err) {
      if (!ac.signal.aborted) {
        if (!(err instanceof HttpError)) log.error('assistant failed', { err })
        const e = err instanceof HttpError ? { error: err.message, code: err.code } : { error: err instanceof Error ? err.message : 'Assistant failed', code: 'server' }
        await stream.writeSSE({ event: 'error', data: JSON.stringify(e) })
      }
    }
  })
})
