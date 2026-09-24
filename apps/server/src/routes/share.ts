import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { exportsTable, shareLinks } from '../db/schema'
import { exportDto, jobDto, projectSummary } from '../dto'
import { HttpError, body, invalid, notFound, requireRole } from '../http'
import { randomToken } from '../ids'
import { enqueue } from '../jobs/queue'
import { serveObject } from '../media/serve'
import { loadAsset } from '../services/assets'
import { loadProjectRow } from '../services/projects'
import { variantTarget } from './assets'

const ExportSchema = z.object({
  resolution: z.enum(['720p', '1080p', '1440p', '4k']).default('1080p'),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(30),
  quality: z.enum(['draft', 'standard', 'high']).default('standard'),
  format: z.enum(['mp4', 'webm', 'gif']).default('mp4'),
  name: z.string().max(200).optional(),
})

/** Mounted at /api/projects (export + share sub-routes). */
export const projectExportRoutes = new Hono<AppEnv>()

projectExportRoutes.post('/:id/export', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, ExportSchema)
  if (row.duration <= 0) throw new HttpError(400, 'invalid', 'The project is empty — add something to the timeline first')
  const j = await enqueue('export.render', { ...b, projectId: row.id }, { workspaceId: row.workspaceId, userId: u.id, projectId: row.id, message: 'Waiting to render' })
  return c.json(jobDto(j))
})

projectExportRoutes.post('/:id/share', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, z.object({ exportId: z.string().optional() }))
  let exportId = b.exportId ?? null
  if (exportId) {
    const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, exportId)).limit(1))[0]
    if (!ex || ex.projectId !== row.id) throw notFound('Export not found')
  } else {
    const latest = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.projectId, row.id)).orderBy(desc(exportsTable.createdAt)).limit(1))[0]
    exportId = latest?.id ?? null
  }
  const token = randomToken(18)
  await ctx().db.insert(shareLinks).values({ token, projectId: row.id, exportId, createdBy: u.id, createdAt: Date.now() })
  return c.json({ url: `${ctx().config.publicUrl ?? ''}/r/${token}`, token })
})

export const exportRoutes = new Hono<AppEnv>()

exportRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const projectId = c.req.query('projectId')
  if (!projectId) throw invalid('projectId is required')
  const row = await loadProjectRow(projectId)
  await requireRole(u.id, row.workspaceId, 'viewer')
  const rows = await ctx().db.select().from(exportsTable).where(eq(exportsTable.projectId, projectId)).orderBy(desc(exportsTable.createdAt)).limit(100)
  return c.json(rows.map(exportDto))
})

/** Public share routes (no auth). */
export const shareRoutes = new Hono<AppEnv>()

async function resolveShare(token: string) {
  const link = (await ctx().db.select().from(shareLinks).where(eq(shareLinks.token, token)).limit(1))[0]
  if (!link) throw notFound('This link is invalid or has been removed')
  const project = await loadProjectRow(link.projectId).catch(() => null)
  if (!project || project.trashedAt) throw notFound('This video is no longer available')
  let ex = link.exportId ? (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, link.exportId)).limit(1))[0] : undefined
  if (!ex) ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.projectId, project.id)).orderBy(desc(exportsTable.createdAt)).limit(1))[0]
  return { link, project, ex }
}

shareRoutes.get('/:token', async (c) => {
  const { project, ex } = await resolveShare(c.req.param('token'))
  const s = projectSummary(project)
  return c.json({ project: { ...s, thumbnailUrl: undefined }, videoUrl: ex ? `/api/share/${encodeURIComponent(c.req.param('token'))}/video` : undefined })
})

shareRoutes.on(['GET', 'HEAD'], '/:token/video', async (c) => {
  const { ex } = await resolveShare(c.req.param('token'))
  if (!ex) throw notFound('No export has been rendered for this project yet')
  const a = await loadAsset(ex.assetId)
  const t = variantTarget(a, 'source')!
  return serveObject(c, { ...t, filename: a.name }, { cache: 'public, max-age=300' })
})
