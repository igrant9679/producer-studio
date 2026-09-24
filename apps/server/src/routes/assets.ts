import path from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import type { UploadTicket } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { assetRecord } from '../dto'
import { HttpError, body, invalid, requireRole } from '../http'
import { newId } from '../ids'
import { enqueue } from '../jobs/queue'
import { assertVariant, serveObject, type Variant } from '../media/serve'
import { type AssetRow, MIME_BY_EXT, assetPrefix, emitAsset, extFor, hashObject, kindFromMime, loadAsset, updateAsset } from '../services/assets'
import { UploadTooLargeError } from '../storage'

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
    }),
  )
  await requireRole(u.id, b.workspaceId, 'editor')
  if (b.assetId) {
    const existing = (await ctx().db.select().from(assets).where(eq(assets.id, b.assetId)).limit(1))[0]
    if (existing) {
      const same = existing.workspaceId === b.workspaceId
      throw new HttpError(409, 'conflict', 'This asset already exists', { exists: true, ...(same ? { asset: assetRecord(existing), sha256: existing.sha256 ?? undefined } : {}) })
    }
  }
  const max = ctx().config.maxUploadBytes
  if (b.size > max) throw new HttpError(413, 'quota', `File is larger than the ${Math.round(max / 1024 / 1024)} MB upload limit`)
  const ext = extFor(b.filename, b.mime)
  const mime = b.mime && b.mime !== 'application/octet-stream' ? b.mime : (MIME_BY_EXT[ext] ?? 'application/octet-stream')
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
      origin: 'upload',
      sourceKey: key,
      meta: {},
      sha256: b.sha256?.toLowerCase() ?? null,
      createdBy: u.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  emitAsset(row)
  const storage = ctx().storage
  const ticket: UploadTicket = storage.presignPut
    ? { assetId: id, url: await storage.presignPut(key, mime), method: 'PUT', headers: { 'content-type': mime } }
    : { assetId: id, url: `/api/uploads/${id}/data`, method: 'PUT', headers: { 'content-type': mime } }
  return c.json(ticket)
})

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
  // content hash: computed here for local storage (streamed), or by asset.process for S3
  let hash = row.sha256
  if (ctx().storage.localPath) {
    const actual = await hashObject(row.sourceKey)
    if (hash && hash !== actual) throw new HttpError(400, 'invalid', 'Uploaded bytes do not match the declared sha256')
    hash = actual
  }
  const updated = await updateAsset(row.id, { status: 'processing', size: st.size, error: null, sha256: hash })
  await enqueue('asset.process', { assetId: row.id }, { workspaceId: row.workspaceId, userId: u.id, projectId: row.projectId, message: 'Processing upload' })
  return c.json(assetRecord(updated))
})

assetRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) throw invalid('workspaceId is required')
  await requireRole(u.id, workspaceId, 'viewer')
  const kind = c.req.query('kind')
  const conds = [eq(assets.workspaceId, workspaceId)]
  if (kind) conds.push(eq(assets.kind, kind))
  const rows = await ctx().db.select().from(assets).where(and(...conds)).orderBy(desc(assets.createdAt)).limit(1000)
  return c.json(rows.map(assetRecord))
})

assetRoutes.get('/:id', async (c) => {
  const u = requireUser(c)
  const row = await loadAsset(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  return c.json(assetRecord(row))
})

assetRoutes.patch('/:id', async (c) => {
  const u = requireUser(c)
  const row = await loadAsset(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, z.object({ name: z.string().trim().min(1).max(200) }))
  return c.json(assetRecord(await updateAsset(row.id, { name: b.name })))
})

assetRoutes.delete('/:id', async (c) => {
  const u = requireUser(c)
  const row = await loadAsset(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  await ctx().db.delete(assets).where(eq(assets.id, row.id))
  await ctx().storage.deletePrefix(assetPrefix(row.workspaceId, row.id) + '/').catch(() => undefined)
  return c.json({ ok: true })
})

/** Storage key + content type for a media variant, with the documented fallbacks. */
export function variantTarget(row: AssetRow, variant: Variant): { key: string; contentType: string; filename?: string } | null {
  switch (variant) {
    case 'source':
      return { key: row.sourceKey, contentType: row.mime, filename: row.name }
    case 'proxy':
      return row.proxyKey ? { key: row.proxyKey, contentType: 'video/mp4' } : { key: row.sourceKey, contentType: row.mime }
    case 'thumb':
      return row.thumbKey ? { key: row.thumbKey, contentType: 'image/jpeg' } : row.kind === 'image' ? { key: row.sourceKey, contentType: row.mime } : null
    case 'filmstrip':
      return row.filmstripKey ? { key: row.filmstripKey, contentType: 'image/jpeg' } : null
    case 'audio':
      return row.audioKey ? { key: row.audioKey, contentType: 'audio/mp4' } : { key: row.sourceKey, contentType: row.mime }
  }
}

export const mediaRoutes = new Hono<AppEnv>()

mediaRoutes.on(['GET', 'HEAD'], '/:assetId/:variant', async (c) => {
  const u = requireUser(c)
  const row = await loadAsset(c.req.param('assetId'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  const target = variantTarget(row, assertVariant(c.req.param('variant')))
  if (!target || (row.status === 'uploading' && target.key === row.sourceKey)) throw new HttpError(404, 'not_found', 'This media variant is not available yet')
  return serveObject(c, target)
})
