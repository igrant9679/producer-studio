import path from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import * as z from 'zod/v4'
import type { UploadTicket } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { assetRecord } from '../dto'
import { HttpError, body, invalid, requireRole } from '../http'
import { newId } from '../ids'
import { cancelJobsOfAsset, enqueue } from '../jobs/queue'
import { waveformKey } from '../media/process'
import { assertVariant, serveObject, type Variant } from '../media/serve'
import { waveformBytes } from '../media/waveform'
import { type AssetRow, assetDirs, assetPrefix, emitAsset, extFor, hashObject, kindFromMime, loadAsset, updateAsset, uploadMime } from '../services/assets'
import { UploadTooLargeError } from '../storage'
import { abortUpload } from '../services/asset-recovery'
import { assertProjectInWorkspace } from '../services/projects'
import { afterCursor, pageOrder, pageQuery, toPage } from '../paging'

export const uploadRoutes = new Hono<AppEnv>()

uploadRoutes.post('/', async (c) => {
  const u = requireUser(c)
  const b = await body(
    c,
    z.object({
      workspaceId: z.string().min(1),
      filename: z.string().min(1).max(300),
      mime: z.string().max(120).default('application/octet-stream'),
      size: z.number().int().min(0),
      projectId: z.string().optional(),
      /** Client-generated global id (desktop replicas keep their asset ids). */
      assetId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/).optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      /** Desktop replicas keep how the asset was made (generated voiceovers stay in Voice Studio's history). */
      origin: z.enum(['upload', 'tts', 'voicestudio', 'dub', 'ai', 'stock', 'freeze']).optional(),
      tts: z.object({ text: z.string().max(10000), voice: z.string().max(80), speed: z.number().min(0.5).max(2) }).optional(),
    }),
  )
  await requireRole(u.id, b.workspaceId, 'editor')
  await assertProjectInWorkspace(b.projectId, b.workspaceId)
  let retry: AssetRow | undefined
  if (b.assetId) {
    const existing = (await ctx().db.select().from(assets).where(eq(assets.id, b.assetId)).limit(1))[0]
    if (existing) {
      // a replica re-pushing its own asset learns it's there; another workspace's id gets a plain conflict
      if (existing.workspaceId !== b.workspaceId) throw new HttpError(409, 'conflict', 'This asset id is taken')
      // ...unless its earlier upload never arrived (connection dropped, or given up on without the file): send it again
      const arrived = existing.status !== 'uploading' && (existing.status !== 'error' || (await ctx().storage.stat(existing.sourceKey)))
      if (arrived) throw new HttpError(409, 'conflict', 'This asset already exists', { exists: true, asset: assetRecord(existing), sha256: existing.sha256 ?? undefined })
      retry = existing
    }
  }
  const max = ctx().config.maxUploadBytes
  if (b.size > max) throw new HttpError(413, 'quota', `File is larger than the ${Math.round(max / 1024 / 1024)} MB upload limit`)
  const mime = uploadMime(b.mime, b.filename)
  if (!mime) throw new HttpError(415, 'invalid', 'Only video, audio and image files can be uploaded')
  if (retry) {
    // same row and storage key; a fresh ticket (and a fresh clock for the abandoned-upload sweep)
    const [row] = await ctx()
      .db.update(assets)
      .set({ status: 'uploading', error: null, size: b.size, sha256: b.sha256?.toLowerCase() ?? retry.sha256, updatedAt: Date.now() })
      .where(eq(assets.id, retry.id))
      .returning()
    emitAsset(row)
    return c.json(await uploadTicket(row.id, row.sourceKey, row.mime, b.size))
  }
  const ext = extFor(b.filename, mime)
  const id = b.assetId ?? newId('as')
  const key = `${assetPrefix(b.workspaceId, id)}/source${ext}`
  const now = Date.now()
  const [row] = await ctx()
    .db.insert(assets)
    .values({
      id,
      workspaceId: b.workspaceId,
      projectId: b.projectId ?? null,
      kind: kindFromMime(mime, b.filename),
      name: path.basename(b.filename).slice(0, 200),
      mime,
      size: b.size,
      status: 'uploading',
      origin: b.origin ?? 'upload',
      sourceKey: key,
      meta: b.tts ? { tts: b.tts } : {},
      sha256: b.sha256?.toLowerCase() ?? null,
      createdBy: u.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  emitAsset(row)
  return c.json(await uploadTicket(id, key, mime, b.size))
})

async function uploadTicket(id: string, key: string, mime: string, size: number): Promise<UploadTicket> {
  const storage = ctx().storage
  return storage.presignPut
    ? { assetId: id, url: await storage.presignPut(key, mime, { size }), method: 'PUT', headers: { 'content-type': mime } }
    : { assetId: id, url: `/api/uploads/${id}/data`, method: 'PUT', headers: { 'content-type': mime } }
}

// Local-storage upload target: stream the request body to disk with a size cap.
uploadRoutes.put('/:assetId/data', async (c) => {
  const u = requireUser(c)
  const row = await loadAsset(c.req.param('assetId'))
  await requireRole(u.id, row.workspaceId, 'editor')
  if (row.status !== 'uploading') throw new HttpError(409, 'conflict', 'This upload has already been completed')
  const raw = c.req.raw.body
  if (!raw) throw invalid('Empty upload body')
  const max = ctx().config.maxUploadBytes
  try {
    const { size } = await ctx().storage.put(row.sourceKey, Readable.fromWeb(raw as import('node:stream/web').ReadableStream), { contentType: row.mime, maxBytes: max })
    await ctx().db.update(assets).set({ size, updatedAt: Date.now() }).where(eq(assets.id, row.id))
    return c.json({ ok: true, size })
  } catch (err) {
    if (err instanceof UploadTooLargeError) throw new HttpError(413, 'quota', err.message)
    throw err
  }
})

export const assetRoutes = new Hono<AppEnv>()

assetRoutes.post('/:id/complete', async (c) => {
  const u = requireUser(c)
  const row = await loadAsset(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  if (row.status !== 'uploading' && row.status !== 'error') return c.json(assetRecord(row))
  const st = await ctx().storage.stat(row.sourceKey)
  if (!st) throw new HttpError(409, 'conflict', 'Upload has not arrived yet — PUT the file to the ticket URL first')
  // the bucket only takes the signed length, but tickets from before that (or other storage) could carry more
  const max = ctx().config.maxUploadBytes
  if (st.size > max) {
    await ctx().storage.delete(row.sourceKey).catch(() => undefined)
    const msg = `This file is larger than the ${Math.round(max / 1024 / 1024)} MB upload limit`
    await updateAsset(row.id, { status: 'error', error: `${msg}.` })
    throw new HttpError(413, 'quota', msg)
  }
  // content hash: computed here for local storage (streamed), or by asset.process for S3
  let hash = row.sha256
  if (ctx().storage.localPath) {
    const actual = await hashObject(row.sourceKey)
    if (hash && hash !== actual) throw new HttpError(400, 'invalid', 'Uploaded bytes do not match the declared sha256')
    hash = actual
  }
  // one conditional update: of two `complete` calls at once, only one moves the clip on and queues processing
  const [claimed] = await ctx()
    .db.update(assets)
    .set({ status: 'processing', size: st.size, error: null, sha256: hash, updatedAt: Date.now() })
    .where(and(eq(assets.id, row.id), inArray(assets.status, ['uploading', 'error'])))
    .returning()
  if (!claimed) return c.json(assetRecord(await loadAsset(row.id)))
  emitAsset(claimed)
  await enqueue('asset.process', { assetId: row.id }, { workspaceId: row.workspaceId, userId: u.id, projectId: row.projectId, message: 'Processing upload' })
  return c.json(assetRecord(claimed))
})

// The browser's PUT to storage failed (refused, network, tab closing): say so now instead of "processing" forever.
assetRoutes.post('/:id/abort', async (c) => {
  const u = requireUser(c)
  const row = await loadAsset(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, z.object({ reason: z.string().max(300).optional() }))
  await abortUpload(row.id, b.reason ?? '')
  return c.json(assetRecord(await loadAsset(row.id)))
})

assetRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) throw invalid('workspaceId is required')
  await requireRole(u.id, workspaceId, 'viewer')
  const kind = c.req.query('kind')
  const { limit, after } = pageQuery(c)
  const conds = [eq(assets.workspaceId, workspaceId)]
  if (kind) conds.push(eq(assets.kind, kind))
  const from = afterCursor(assets.createdAt, assets.id, after)
  if (from) conds.push(from)
  const rows = await ctx()
    .db.select()
    .from(assets)
    .where(and(...conds))
    .orderBy(...pageOrder(assets.createdAt, assets.id))
    .limit(limit + 1)
  // light records: a list of clips never carries their transcripts (GET /api/assets/:id does)
  return c.json(toPage(rows, limit, (r) => [r.createdAt, r.id], (r) => assetRecord(r, { light: true })))
})

assetRoutes.get('/:id', async (c) => {
  const u = requireUser(c)
  const row = await loadAsset(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  return c.json(assetRecord(row))
})

/** A clip's transcript as a desktop sends one it made (PATCH /api/assets/:id). */
const TranscriptSchema = z.object({
  language: z.string().max(40),
  engine: z.string().max(80),
  segments: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        text: z.string().max(20_000),
        words: z.array(z.object({ w: z.string().max(400), start: z.number(), end: z.number() })).max(10_000),
        speaker: z.string().max(120).optional(),
      }),
    )
    .max(50_000),
})

assetRoutes.patch('/:id', async (c) => {
  const u = requireUser(c)
  const row = await loadAsset(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, z.object({ name: z.string().trim().min(1).max(200).optional(), transcript: TranscriptSchema.optional() }).refine((x) => x.name !== undefined || x.transcript !== undefined, 'Nothing to change'))
  return c.json(assetRecord(await updateAsset(row.id, { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.transcript ? { meta: { transcript: b.transcript } } : {}) })))
})

assetRoutes.delete('/:id', async (c) => {
  const u = requireUser(c)
  const row = await loadAsset(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  // its processing and transcription stop first; whatever they write after this is swept when they end
  await cancelJobsOfAsset(row.id)
  await ctx().db.delete(assets).where(eq(assets.id, row.id))
  for (const dir of assetDirs(row)) await ctx().storage.deletePrefix(dir).catch(() => undefined)
  return c.json({ ok: true })
})

/** Storage key + content type for a media variant, with the documented fallbacks. */
export function variantTarget(row: AssetRow, variant: Variant): { key: string; contentType: string; filename?: string } | null {
  switch (variant) {
    case 'source':
      return { key: row.sourceKey, contentType: row.mime, filename: row.name }
    case 'proxy':
      // a picture's "proxy" is the PNG copy of a format browsers can't draw (TIFF); a sound's, the AAC copy of one
      // they can't play (AIFF, WMA, AMR)
      if (row.proxyKey) return { key: row.proxyKey, contentType: row.kind === 'image' ? 'image/png' : row.proxyKey.endsWith('.webm') ? 'video/webm' : 'video/mp4' }
      if (row.kind === 'audio' && row.audioKey) return { key: row.audioKey, contentType: 'audio/mp4' }
      return { key: row.sourceKey, contentType: row.mime }
    case 'thumb':
      return row.thumbKey ? { key: row.thumbKey, contentType: 'image/jpeg' } : row.kind === 'image' ? { key: row.sourceKey, contentType: row.mime } : null
    case 'filmstrip':
      return row.filmstripKey ? { key: row.filmstripKey, contentType: 'image/jpeg' } : null
    case 'audio':
      return row.audioKey ? { key: row.audioKey, contentType: 'audio/mp4' } : { key: row.sourceKey, contentType: row.mime }
    case 'waveform':
      return row.meta?.waveformFull ? { key: waveformKey(row), contentType: 'application/octet-stream' } : null
  }
}

export const mediaRoutes = new Hono<AppEnv>()

mediaRoutes.on(['GET', 'HEAD'], '/:assetId/:variant', async (c) => {
  const u = requireUser(c)
  const row = await loadAsset(c.req.param('assetId'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  const variant = assertVariant(c.req.param('variant'))
  const target = variantTarget(row, variant)
  if (variant === 'waveform' && !target && row.meta?.waveform?.length) {
    // a clip processed before the full waveform became a file: every peak is still in its metadata
    return c.body(new Uint8Array(waveformBytes(row.meta.waveform)), 200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' })
  }
  if (!target || (row.status === 'uploading' && target.key === row.sourceKey)) throw new HttpError(404, 'not_found', 'This media variant is not available yet')
  if (ctx().config.mode === 'desktop') {
    // cloud media on a desktop replica: fetched on first use (202 while downloading)
    const { desktopMediaResponse } = await import('../desktop/media')
    const r = await desktopMediaResponse(c, row, target.key)
    if (r) return r
  }
  // the editor fetch()es the waveform: through this server, not a redirect to a bucket that may not allow CORS
  return serveObject(c, target, variant === 'waveform' ? { redirect: false } : {})
})
