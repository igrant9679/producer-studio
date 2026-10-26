// /api/voicestudio/* (desktop only): engine lifecycle, the allow-listed same-origin proxy the Voice Studio UI uses for
// VoiceStudio's own API (/api/voicestudio/x/<vs path>), and the Producer-side operations: create a cloned/designed voice
// (with a consent record) and import any VoiceStudio output (takes, dubs, audiobooks, isolated stems) into the library.
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import { type AppEnv, requireUser } from '../../auth'
import { ctx } from '../../context'
import { workspaces } from '../../db/schema'
import { jobDto } from '../../dto'
import { HttpError, body, requireRole } from '../../http'
import { enqueue } from '../../jobs/queue'
import { voiceProfileDto, voicesChangedLocally } from '../../routes/voice'
import { vs } from './client'
import { adoptVoice, createVoice } from './profiles'
import { VS_SOURCE_URL, VS_VERSION, voiceStudio } from './runtime'

export const voiceStudioRoutes = new Hono<AppEnv>()

voiceStudioRoutes.get('/status', (c) => {
  requireUser(c)
  return c.json({ ...voiceStudio.status(), sourceUrl: VS_SOURCE_URL, log: voiceStudio.logTail(30) })
})

/** Live status (install progress, start/stop) as SSE. */
voiceStudioRoutes.get('/status/stream', (c) => {
  requireUser(c)
  return streamSSE(c, async (stream) => {
    let closed = false
    const queue: string[] = [JSON.stringify(voiceStudio.status())]
    let wake: (() => void) | undefined
    const off = voiceStudio.onChange((s) => {
      queue.push(JSON.stringify(s))
      wake?.()
    })
    stream.onAbort(() => {
      closed = true
      off()
      wake?.()
    })
    const ka = setInterval(() => void stream.write(': keepalive\n\n').catch(() => undefined), 20_000)
    try {
      while (!closed) {
        while (queue.length) await stream.writeSSE({ event: 'status', data: queue.shift()! })
        await new Promise<void>((r) => (wake = r))
        wake = undefined
      }
    } finally {
      clearInterval(ka)
      off()
    }
  })
})

async function personalWorkspace(userId: string): Promise<string> {
  const { listWorkspaces } = await import('../../routes/workspaces')
  const list = await listWorkspaces(userId)
  const ws = list.find((w) => w.personal) ?? list[0]
  if (!ws) throw new HttpError(409, 'conflict', 'No workspace')
  return ws.id
}

voiceStudioRoutes.post('/install', async (c) => {
  const u = requireUser(c)
  const s = voiceStudio.status()
  if (!s.supported) throw new HttpError(400, 'invalid', 'VoiceStudio runs on Producer Studio for Windows')
  if (s.state === 'installing') throw new HttpError(409, 'conflict', 'VoiceStudio is already being installed')
  const ws = await personalWorkspace(u.id)
  const j = await enqueue('voicestudio.install', {}, { workspaceId: ws, userId: u.id, message: `Installing VoiceStudio ${VS_VERSION}` })
  return c.json(jobDto(j))
})

voiceStudioRoutes.post('/start', async (c) => {
  requireUser(c)
  await voiceStudio.start()
  return c.json(voiceStudio.status())
})

voiceStudioRoutes.post('/stop', async (c) => {
  requireUser(c)
  await voiceStudio.stop()
  return c.json(voiceStudio.status())
})

// ---------------- voices ----------------

const ConsentSchema = z.object({
  agreed: z.literal(true, { message: 'Confirm you have the right to use this voice' }),
  speaker: z.string().trim().max(120).optional(),
  statement: z.string().trim().min(10).max(2000),
})

/** Create a cloned (multipart with `audio`) or designed voice. Fields: workspaceId, name, kind, engine, language,
 *  gender, description, refText, instruct, vdStates (JSON), seed, consent (JSON {agreed, speaker, statement}). */
voiceStudioRoutes.post('/voices', async (c) => {
  const u = requireUser(c)
  const form = await c.req.formData().catch(() => {
    throw new HttpError(400, 'invalid', 'Expected multipart form data')
  })
  const str = (k: string) => {
    const v = form.get(k)
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  const workspaceId = str('workspaceId')
  if (!workspaceId) throw new HttpError(400, 'invalid', 'workspaceId is required')
  await requireRole(u.id, workspaceId, 'editor')
  const name = str('name')
  if (!name || name.length > 80) throw new HttpError(400, 'invalid', 'Give the voice a name (up to 80 characters)')
  const kind = str('kind') === 'design' ? 'design' : 'clone'
  let consentRaw: unknown
  try {
    consentRaw = JSON.parse(str('consent') ?? '{}')
  } catch {
    throw new HttpError(400, 'invalid', 'consent must be JSON')
  }
  const consent = ConsentSchema.safeParse(consentRaw)
  if (!consent.success) throw new HttpError(400, 'invalid', consent.error.issues[0]?.message ?? 'Consent is required')
  const audio = form.get('audio')
  if (kind === 'clone') {
    if (!(audio instanceof File) || audio.size < 1000) throw new HttpError(400, 'invalid', 'Add a reference recording (a clean 5–30 second clip works best)')
    if (audio.size > 100 * 1024 ** 2) throw new HttpError(400, 'invalid', 'The reference recording is too large (100 MB max)')
  }
  let vdStates: Record<string, string> | undefined
  if (kind === 'design') {
    try {
      vdStates = JSON.parse(str('vdStates') ?? '{}') as Record<string, string>
    } catch {
      throw new HttpError(400, 'invalid', 'vdStates must be JSON')
    }
  }
  const seed = str('seed') ? Number(str('seed')) : undefined
  const row = await createVoice({
    workspaceId,
    userId: u.id,
    name,
    kind,
    engine: str('engine') ?? '',
    language: str('language'),
    gender: str('gender'),
    description: str('description'),
    audio: audio instanceof File ? { data: audio, filename: audio.name || 'reference.wav' } : undefined,
    refText: str('refText'),
    instruct: str('instruct'),
    vdStates,
    seed: Number.isFinite(seed) ? seed : undefined,
    consent: { statement: consent.data.statement, speaker: consent.data.speaker, attestedBy: u.id, attestedAt: Date.now() },
  })
  await voicesChangedLocally()
  return c.json(voiceProfileDto(row))
})

/** Adopt an existing VoiceStudio profile (e.g. created from a preset voice) as a voice of this space. */
voiceStudioRoutes.post('/voices/adopt', async (c) => {
  const u = requireUser(c)
  const b = await body(
    c,
    z.object({
      workspaceId: z.string().min(1),
      vsProfileId: z.string().min(1).max(120),
      name: z.string().trim().min(1).max(80),
      kind: z.enum(['clone', 'design']).default('design'),
      engine: z.string().max(80).default(''),
      language: z.string().max(60).optional(),
      gender: z.string().max(20).optional(),
      description: z.string().max(2000).optional(),
      consent: ConsentSchema,
    }),
  )
  await requireRole(u.id, b.workspaceId, 'editor')
  const row = await adoptVoice({ ...b, userId: u.id, consent: { statement: b.consent.statement, speaker: b.consent.speaker, attestedBy: u.id, attestedAt: Date.now() } })
  await voicesChangedLocally()
  return c.json(voiceProfileDto(row))
})

// ---------------- import VoiceStudio outputs into the library ----------------

const IMPORT_ROOTS = /^\/(audio|voice_audio|dub|batch|audiobook|preview)(\/|$)/

/**
 * Whether `source` is a VoiceStudio output path the import may fetch. fetch() resolves `..` (also written `%2e%2e`,
 * or with backslashes) before the request leaves, so `/audio/../system/…` would reach any VoiceStudio route: such
 * paths are refused outright, and the prefix is checked on the path exactly as it will be requested.
 */
export function isImportSource(source: string): boolean {
  if (/[\\\u0000-\u001f\u007f#]|%2e/i.test(source)) return false
  const q = source.indexOf('?')
  const pathPart = q < 0 ? source : source.slice(0, q)
  if (pathPart.split('/').some((seg) => seg === '.' || seg === '..')) return false
  let u: URL
  try {
    u = new URL(source, 'http://voicestudio.invalid')
  } catch {
    return false
  }
  // normalising must not change the path (no dot segments or stray characters, still on the same origin)
  if (u.origin !== 'http://voicestudio.invalid' || u.pathname !== pathPart) return false
  return IMPORT_ROOTS.test(u.pathname)
}

const ImportSchema = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().optional(),
  /** VoiceStudio path of the output, e.g. /audio/ab12cd34.wav, /dub/download/<job>?…, /dub/download-audio/<job>?lang=es */
  source: z.string().min(2).max(1000).refine(isImportSource, 'Unsupported VoiceStudio output'),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['audio', 'video']),
  /** File extension hint when the response has no filename (".wav", ".mp4", ".m4b"…) */
  ext: z.string().max(8).optional(),
  origin: z.enum(['tts', 'voicestudio', 'dub']).default('voicestudio'),
})

voiceStudioRoutes.post('/import', async (c) => {
  const u = requireUser(c)
  const b = await body(c, ImportSchema)
  await requireRole(u.id, b.workspaceId, 'editor')
  const ws = (await ctx().db.select().from(workspaces).where(eq(workspaces.id, b.workspaceId)).limit(1))[0]
  if (!ws) throw new HttpError(404, 'not_found', 'Workspace not found')
  const j = await enqueue('voicestudio.task', { op: 'import', ...b }, { workspaceId: b.workspaceId, userId: u.id, projectId: b.projectId, message: `Importing ${b.name}` })
  return c.json(jobDto(j))
})

// ---------------- send a library asset into VoiceStudio ----------------

/** VoiceStudio endpoints that take an uploaded media file, and the form field they read it from. */
const ASSET_TARGETS: Record<string, { path: string; field: string; variant?: 'audio' }> = {
  dub: { path: '/dub/upload', field: 'video' },
  batch: { path: '/batch/enqueue', field: 'video' },
  gallery: { path: '/gallery/upload', field: 'audio', variant: 'audio' },
  'clean-audio': { path: '/clean-audio', field: 'audio', variant: 'audio' },
  transcribe: { path: '/transcribe', field: 'audio', variant: 'audio' },
  'audiobook-import': { path: '/audiobook/import', field: 'file' },
}

/** POST /api/voicestudio/asset-to/:target?assetId=… plus extra form fields as query (e.g. input_type, source_lang,
 *  job_id, language). Streams the library file (the extracted audio track when it suffices) to VoiceStudio and passes its
 *  response back — no round trip of large videos through the browser. */
voiceStudioRoutes.post('/asset-to/:target', async (c) => {
  const u = requireUser(c)
  const t = ASSET_TARGETS[c.req.param('target')]
  if (!t) throw new HttpError(404, 'not_found', 'Unknown target')
  const assetId = c.req.query('assetId')
  if (!assetId) throw new HttpError(400, 'invalid', 'assetId is required')
  const { loadAsset, localSource, tmpDir } = await import('../../services/assets')
  const row = await loadAsset(assetId)
  await requireRole(u.id, row.workspaceId, 'viewer')
  const work = tmpDir('vs-send')
  try {
    const key = t.variant === 'audio' && row.audioKey ? row.audioKey : row.sourceKey
    const file = await localSource(row, work, key)
    const form = new FormData()
    const ext = path.extname(key) || path.extname(row.name)
    const base = row.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'media'
    form.set(t.field, await fs.openAsBlob(file), `${base}${ext}`)
    const url = new URL(c.req.url)
    for (const [k, v] of url.searchParams) if (k !== 'assetId') form.set(k, v)
    const res = await vs(t.path, { method: 'POST', form, signal: c.req.raw.signal, timeoutMs: 60 * 60_000 })
    const out = new Headers()
    res.headers.forEach((v, k) => {
      if (PASS_RES.test(k)) out.set(k, v)
    })
    // buffer: the temp copy (S3 storage) is removed when we return
    const buf = await res.arrayBuffer()
    return new Response(buf, { status: res.status, headers: out })
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
})

// ---------------- batch dubbing: add finished outputs to the library ----------------

const TrackSchema = z.object({
  jobId: z.string().regex(/^[\w-]{4,64}$/),
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  langs: z.array(z.string().max(20)).min(1).max(20),
})

/** Remember a VoiceStudio batch job so its dubbed videos are imported into the space when it finishes. */
voiceStudioRoutes.post('/batch/track', async (c) => {
  const u = requireUser(c)
  const b = await body(c, TrackSchema)
  await requireRole(u.id, b.workspaceId, 'editor')
  const { trackBatch } = await import('./batch')
  await trackBatch({ ...b, userId: u.id })
  return c.json({ ok: true })
})

voiceStudioRoutes.get('/batch/tracked', async (c) => {
  requireUser(c)
  const { trackedBatches } = await import('./batch')
  return c.json(await trackedBatches())
})

voiceStudioRoutes.delete('/batch/track/:jobId', async (c) => {
  requireUser(c)
  const { untrackBatch } = await import('./batch')
  await untrackBatch(c.req.param('jobId'))
  return c.json({ ok: true })
})

// ---------------- proxy to VoiceStudio's own API ----------------

/** VoiceStudio routes the Voice Studio UI may call. Admin/system, telephony, marketplace, MCP and auth stay blocked. */
const ALLOW: Array<[RegExp, RegExp]> = [
  [/^(GET|HEAD)$/, /^\/(health|startup\/progress|tools\/effects|perf\/|performance-profile|model\/(loaded|status))/],
  [/^(GET|POST|PUT|DELETE)$/, /^\/profiles(\/|$)/],
  [/^(GET|POST|PUT|DELETE)$/, /^\/history(\/|$)/],
  [/^(GET|POST)$/, /^\/generate(\/|$)/],
  [/^(GET|HEAD)$/, /^\/(audio|voice_audio)\//],
  [/^(GET|POST)$/, /^\/design\//],
  [/^(GET|POST|PATCH|DELETE)$/, /^\/gallery\//],
  [/^(GET|POST)$/, /^\/archetypes(\/|$|\?)/],
  [/^(GET|POST)$/, /^\/engines(\/|$)/],
  [/^(GET|POST|DELETE)$/, /^\/models(\/|$)/],
  [/^GET$/, /^\/setup\/download-stream/],
  [/^(GET|POST|DELETE)$/, /^\/dub(\/|$)/],
  [/^(GET|POST)$/, /^\/tasks\//],
  [/^GET$/, /^\/jobs(\/|$)/],
  [/^(GET|POST)$/, /^\/audiobook(\/|$)/],
  [/^POST$/, /^\/stories\//],
  [/^(GET|POST|DELETE)$/, /^\/batch\//],
  [/^POST$/, /^\/(transcribe|clean-audio)$/],
  [/^(GET|POST)$/, /^\/api\/settings\/license(\/|$)/],
  [/^(GET|POST)$/, /^\/dictation\/(models|readiness|prefs)$/],
  [/^(GET|POST)$/, /^\/community\/(sources|manifest|items)(\/|$)/],
  [/^POST$/, /^\/personas\/(export\/[^/]+|import|inspect)$/],
  [/^GET$/, /^\/longform\/jobs(\/|$)/],
  [/^POST$/, /^\/longform\/render$/],
  [/^GET$/, /^\/v1\/audio\/voices$/],
  [/^POST$/, /^\/v1\/audio\/(transcriptions|translations)$/],
]

const PASS_REQ = ['content-type', 'accept', 'range', 'last-event-id']
const PASS_RES = /^(content-type|content-length|content-disposition|content-range|accept-ranges|cache-control|retry-after|x-audio-|x-seed|x-gen-time|x-omnivoice-|x-clean-)/i

voiceStudioRoutes.all('/x/*', async (c) => {
  requireUser(c)
  const url = new URL(c.req.url)
  const vsPath = url.pathname.replace(/^\/api\/voicestudio\/x/, '') || '/'
  if (vsPath.includes('..') || !ALLOW.some(([m, p]) => m.test(c.req.method) && p.test(vsPath))) throw new HttpError(403, 'forbidden', `VoiceStudio route not available here: ${c.req.method} ${vsPath}`)
  const headers: Record<string, string> = {}
  for (const h of PASS_REQ) {
    const v = c.req.header(h)
    if (v) headers[h] = v
  }
  const hasBody = !['GET', 'HEAD'].includes(c.req.method)
  const res = await vs(`${vsPath}${url.search}`, { method: c.req.method, headers, body: hasBody ? (c.req.raw.body ?? undefined) : undefined, signal: c.req.raw.signal })
  const out = new Headers()
  res.headers.forEach((v, k) => {
    if (PASS_RES.test(k)) out.set(k, v)
  })
  out.set('x-content-type-options', 'nosniff')
  return new Response(res.body, { status: res.status, headers: out })
})

// ---------------- job handlers (desktop worker) ----------------

export async function runImport(input: z.infer<typeof ImportSchema> & { op: 'import' }, userId: string, jc: { progress: (f: number, m?: string) => void; signal: AbortSignal; check: () => void }) {
  const { createAssetFromFile, tmpDir } = await import('../../services/assets')
  const { processAsset } = await import('../../media/process')
  const { assetRecord } = await import('../../dto')
  const work = tmpDir('vs-import')
  try {
    // re-checked here too: a job queued before this check existed may still be waiting
    if (!isImportSource(input.source)) throw new Error('Unsupported VoiceStudio output')
    jc.progress(0.05, 'Fetching from VoiceStudio')
    const res = await vs(input.source, { signal: jc.signal, timeoutMs: 60 * 60_000 })
    if (!res.ok || !res.body) throw new Error(`VoiceStudio couldn’t provide that file (HTTP ${res.status})`)
    const cd = res.headers.get('content-disposition') ?? ''
    const fname = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd)?.[1]
    const ext = (fname && path.extname(decodeURIComponent(fname))) || input.ext || (input.kind === 'video' ? '.mp4' : '.wav')
    const file = path.join(work, `import${ext}`)
    const total = Number(res.headers.get('content-length')) || 0
    const outStream = fs.createWriteStream(file)
    let got = 0
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      jc.check()
      if (!outStream.write(chunk)) await new Promise<void>((r) => outStream.once('drain', () => r()))
      got += chunk.byteLength
      if (total) jc.progress(0.05 + (got / total) * 0.55, 'Fetching from VoiceStudio')
    }
    await new Promise<void>((r) => outStream.end(() => r()))
    const mime = res.headers.get('content-type')?.split(';')[0] || (input.kind === 'video' ? 'video/mp4' : 'audio/wav')
    const created = await createAssetFromFile({ workspaceId: input.workspaceId, userId, projectId: input.projectId, filePath: file, name: input.name, mime, kind: input.kind, origin: input.origin })
    jc.progress(0.65, 'Processing')
    const row = await processAsset(created.id, { signal: jc.signal, check: jc.check, progress: (f) => jc.progress(0.65 + f * 0.35, 'Processing') })
    return { asset: assetRecord(row) }
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}
