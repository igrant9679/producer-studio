import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import * as z from 'zod/v4'
import { ASPECT_RATIOS, type ShareLink, type SharedVideo } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { assets, exportsTable, jobs, shareLinks } from '../db/schema'
import { previewKey } from '../render/export'
import { exportDto, jobDto, projectSummary } from '../dto'
import { HttpError, body, invalid, notFound, requireRole } from '../http'
import { randomToken } from '../ids'
import { enqueue } from '../jobs/queue'
import { assertQueueRoom } from '../limits'
import { serveObject } from '../media/serve'
import { loadAsset } from '../services/assets'
import { loadProjectRow } from '../services/projects'
import { variantTarget } from './assets'

const ExportSchema = z.object({
  resolution: z.enum(['720p', '1080p', '1440p', '4k']).default('1080p'),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(30),
  quality: z.enum(['draft', 'standard', 'high']).default('standard'),
  format: z.enum(['mp4', 'webm', 'gif', 'mp3', 'wav']).default('mp4'),
  name: z.string().max(200).optional(),
  range: z
    .object({ from: z.number().min(0).max(1e6), to: z.number().min(0).max(1e6) })
    .refine((r) => r.to - r.from >= 0.1, 'The range must be at least 0.1 s long')
    .optional(),
  aspect: z.enum(ASPECT_RATIOS.map((a) => a.id) as [string, ...string[]]).optional(),
  captions: z.enum(['burn', 'sidecar', 'none']).optional(),
  captionFormat: z.enum(['srt', 'vtt']).optional(),
  captionTrackId: z.string().max(100).optional(),
  coverAt: z.number().min(0).max(1e6).optional(),
  preview: z.boolean().optional(),
})

/** Mounted at /api/projects (export + share sub-routes). */
export const projectExportRoutes = new Hono<AppEnv>()

projectExportRoutes.post('/:id/export', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, ExportSchema)
  if (row.duration <= 0) throw new HttpError(400, 'invalid', 'The project is empty — add something to the timeline first')
  if (b.range && b.range.from >= row.duration) throw new HttpError(400, 'invalid', 'That range starts after the end of the video')
  await assertQueueRoom(row.workspaceId)
  const j = await enqueue('export.render', { ...b, projectId: row.id }, { workspaceId: row.workspaceId, userId: u.id, projectId: row.id, message: b.preview ? 'Waiting to render the draft' : 'Waiting to render' })
  return c.json(jobDto(j))
})

/** The latest draft preview (export with `preview`): only that project's, only while it is the latest. */
projectExportRoutes.on(['GET', 'HEAD'], '/:id/previews/:jobId', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  const job = (await ctx().db.select().from(jobs).where(eq(jobs.id, c.req.param('jobId'))).limit(1))[0]
  if (!job || job.projectId !== row.id || job.kind !== 'export.render' || job.status !== 'done') throw notFound('This draft is not available')
  return serveObject(c, { key: previewKey(row.workspaceId, row.id, job.id), contentType: 'video/mp4', filename: `${row.name} draft.mp4` }, { cache: 'private, max-age=300' })
})

const shareUrl = (token: string) => `${ctx().config.publicUrl ?? ''}/r/${token}`

/**
 * A share link always shows one finished export: the one asked for, else the latest. Sharing the same export again
 * returns its existing link rather than a new one. With nothing exported yet there is nothing to share.
 */
projectExportRoutes.post('/:id/share', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, z.object({ exportId: z.string().optional() }))
  let exportId: string
  if (b.exportId) {
    const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, b.exportId)).limit(1))[0]
    if (!ex || ex.projectId !== row.id) throw notFound('Export not found')
    exportId = ex.id
  } else {
    const latest = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.projectId, row.id)).orderBy(desc(exportsTable.createdAt)).limit(1))[0]
    if (!latest) throw new HttpError(409, 'conflict', 'Export the video first: a share link shows a finished export.')
    exportId = latest.id
  }
  const existing = (await ctx().db.select().from(shareLinks).where(and(eq(shareLinks.projectId, row.id), eq(shareLinks.exportId, exportId))).limit(1))[0]
  if (existing) return c.json({ token: existing.token, url: shareUrl(existing.token), exportId, createdAt: existing.createdAt } satisfies ShareLink)
  const token = randomToken(18)
  const createdAt = Date.now()
  await ctx().db.insert(shareLinks).values({ token, projectId: row.id, exportId, createdBy: u.id, createdAt })
  return c.json({ token, url: shareUrl(token), exportId, createdAt } satisfies ShareLink)
})

projectExportRoutes.get('/:id/shares', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  const rows = await ctx().db.select().from(shareLinks).where(eq(shareLinks.projectId, row.id)).orderBy(desc(shareLinks.createdAt))
  return c.json(rows.filter((r) => r.exportId).map((r): ShareLink => ({ token: r.token, url: shareUrl(r.token), exportId: r.exportId!, createdAt: r.createdAt })))
})

export const exportRoutes = new Hono<AppEnv>()

exportRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const projectId = c.req.query('projectId')
  if (!projectId) throw invalid('projectId is required')
  const row = await loadProjectRow(projectId)
  await requireRole(u.id, row.workspaceId, 'viewer')
  const rows = await ctx().db.select().from(exportsTable).where(eq(exportsTable.projectId, projectId)).orderBy(desc(exportsTable.createdAt)).limit(100)
  // which exports have a sidecar caption file beside them
  const files = rows.length ? await ctx().db.select({ id: assets.id, meta: assets.meta }).from(assets).where(inArray(assets.id, rows.map((r) => r.assetId))) : []
  const withCaptions = new Set(files.filter((f) => f.meta?.captions).map((f) => f.id))
  return c.json(rows.map((r) => exportDto(r, withCaptions.has(r.assetId))))
})

/** An export's sidecar captions (SRT or WebVTT), saved as a file. */
exportRoutes.on(['GET', 'HEAD'], '/:id/captions', async (c) => {
  const u = requireUser(c)
  const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, c.req.param('id'))).limit(1))[0]
  if (!ex) throw notFound('Export not found')
  await requireRole(u.id, ex.workspaceId, 'viewer')
  const a = await loadAsset(ex.assetId)
  const cap = a.meta?.captions
  if (!cap) throw notFound('This export has no caption file')
  return serveObject(c, { key: cap.key, contentType: cap.format === 'srt' ? 'application/x-subrip' : 'text/vtt', filename: `${ex.name}.${cap.format}` }, { cache: 'private, max-age=300' })
})

/** Public share routes (no auth). */
export const shareRoutes = new Hono<AppEnv>()

async function resolveShare(token: string) {
  const link = (await ctx().db.select().from(shareLinks).where(eq(shareLinks.token, token)).limit(1))[0]
  if (!link) throw notFound('This link is invalid or has been removed')
  const project = await loadProjectRow(link.projectId).catch(() => null)
  if (!project || project.trashedAt) throw notFound('This video is no longer available')
  let ex = link.exportId ? (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, link.exportId)).limit(1))[0] : undefined
  if (!ex && !link.exportId) {
    // a link made before links were pinned: pin it to what it shows now, so later drafts never go public through it
    ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.projectId, project.id)).orderBy(desc(exportsTable.createdAt)).limit(1))[0]
    if (ex) await ctx().db.update(shareLinks).set({ exportId: ex.id }).where(and(eq(shareLinks.token, link.token), isNull(shareLinks.exportId)))
  }
  return { link, project, ex }
}

shareRoutes.get('/:token', async (c) => {
  const { project, ex } = await resolveShare(c.req.param('token'))
  const s = projectSummary(project)
  const base = `/api/share/${encodeURIComponent(c.req.param('token'))}`
  const poster = ex ? (await loadAsset(ex.assetId).catch(() => null))?.thumbKey : undefined
  // public: only what the page shows (no workspace, creator or internal ids)
  const shared: SharedVideo = {
    project: { name: s.name, width: s.width, height: s.height, duration: s.duration, updatedAt: s.updatedAt },
    videoUrl: ex ? `${base}/video` : undefined,
    posterUrl: poster ? `${base}/poster` : undefined,
  }
  return c.json(shared)
})

/** Stop sharing: the link's page and video stop working at once. */
shareRoutes.delete('/:token', async (c) => {
  const u = requireUser(c)
  const link = (await ctx().db.select().from(shareLinks).where(eq(shareLinks.token, c.req.param('token'))).limit(1))[0]
  if (!link) throw notFound('This link is invalid or has been removed')
  const project = await loadProjectRow(link.projectId)
  await requireRole(u.id, project.workspaceId, 'editor')
  await ctx().db.delete(shareLinks).where(eq(shareLinks.token, link.token))
  return c.json({ ok: true })
})

shareRoutes.on(['GET', 'HEAD'], '/:token/video', async (c) => {
  const { ex } = await resolveShare(c.req.param('token'))
  if (!ex) throw notFound('No export has been rendered for this project yet')
  const a = await loadAsset(ex.assetId)
  const t = variantTarget(a, 'source')!
  return serveObject(c, { ...t, filename: a.name }, { cache: 'public, max-age=300' })
})

/** The shared export's thumbnail, for the page's poster: public like the video, and only while the link works. */
shareRoutes.on(['GET', 'HEAD'], '/:token/poster', async (c) => {
  const { ex } = await resolveShare(c.req.param('token'))
  const a = ex ? await loadAsset(ex.assetId).catch(() => null) : null
  const t = a && variantTarget(a, 'thumb')
  if (!t) throw notFound('This video has no poster')
  return serveObject(c, t, { cache: 'public, max-age=300' })
})
