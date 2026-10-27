import { Hono } from 'hono'
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import * as z from 'zod/v4'
import { createProject, uid, type Project, type ProjectDocResponse } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { projects } from '../db/schema'
import { projectSummary } from '../dto'
import { HttpError, body, invalid, notFound, requireRole } from '../http'
import { getLook, starterProject } from '../services/looks'
import { hydrateAssets, insertProject, loadProjectRow, saveProjectDoc, validateProject, withFreshIds } from '../services/projects'
import { getBrand } from './workspaces'

export const projectRoutes = new Hono<AppEnv>()

/** Tell open screens (home, library, editors, desktops) that a project was made, changed, trashed or deleted. */
function announce(row: { id: string; workspaceId: string; version: number }, deleted = false) {
  const data = deleted ? { id: row.id, version: row.version, deleted: true } : { id: row.id, version: row.version }
  ctx().bus.publish(row.workspaceId, 'project', data, { id: row.id, inline: data })
}

projectRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) throw invalid('workspaceId is required')
  await requireRole(u.id, workspaceId, 'viewer')
  const trashed = c.req.query('trashed') === '1'
  const templates = c.req.query('templates')
  const conds = [eq(projects.workspaceId, workspaceId), trashed ? isNotNull(projects.trashedAt) : isNull(projects.trashedAt)]
  if (templates === '1') conds.push(eq(projects.isTemplate, true))
  else if (templates === '0') conds.push(eq(projects.isTemplate, false))
  const rows = await ctx()
    .db.select({
      id: projects.id,
      workspaceId: projects.workspaceId,
      name: projects.name,
      kind: projects.kind,
      version: projects.version,
      thumbnail: projects.thumbnail,
      duration: projects.duration,
      width: projects.width,
      height: projects.height,
      isTemplate: projects.isTemplate,
      trashedAt: projects.trashedAt,
      createdBy: projects.createdBy,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      changeSeq: projects.changeSeq,
    })
    .from(projects)
    .where(and(...conds))
    .orderBy(desc(projects.updatedAt))
    .limit(500)
  return c.json(rows.map((r) => projectSummary({ ...r, doc: undefined as never })))
})

export const ID_RE = /^[A-Za-z0-9_-]{6,80}$/

const CreateSchema = z.object({
  /** Client-generated global id (desktop replicas keep their ids). */
  id: z.string().regex(ID_RE, 'id must be 6-80 characters of A-Z a-z 0-9 _ -').optional(),
  /** Full document to create with (desktop push of a locally created project). */
  project: z.unknown().optional(),
  workspaceId: z.string().min(1),
  name: z.string().trim().max(200).optional(),
  width: z.number().int().min(16).max(8192).optional(),
  height: z.number().int().min(16).max(8192).optional(),
  fps: z.number().min(1).max(120).optional(),
  templateId: z.string().max(100).optional(),
  kind: z.enum(['edit', 'producer']).optional(),
})

projectRoutes.post('/', async (c) => {
  const u = requireUser(c)
  const b = await body(c, CreateSchema)
  await requireRole(u.id, b.workspaceId, 'editor')
  const id = b.id ?? uid('p')
  if (b.id) {
    const existing = await loadProjectRow(b.id).catch(() => null)
    // another workspace's id: the same answer as any collision, so it says nothing about what exists elsewhere
    if (existing && existing.workspaceId !== b.workspaceId) throw new HttpError(409, 'conflict', 'This project id is taken. Duplicate the project to save a copy.')
    if (existing) {
      // idempotent retry of the same create
      const res: ProjectDocResponse = { summary: projectSummary(existing), project: await hydrateAssets(existing.doc, existing.workspaceId), version: existing.version }
      return c.json(res)
    }
  }
  let doc: Project
  if (b.project !== undefined) {
    doc = validateProject({ ...(b.project as Project), id })
  } else if (b.templateId?.startsWith('tpl:')) {
    const look = getLook(b.templateId.slice(4))
    if (look.id !== b.templateId.slice(4)) throw notFound('Template not found')
    doc = starterProject(look, { name: b.name || look.name, brand: await getBrand(b.workspaceId) })
    doc.id = id
    if (b.fps) doc.fps = b.fps
  } else if (b.templateId) {
    const tpl = await loadProjectRow(b.templateId).catch(() => null)
    if (!tpl || tpl.workspaceId !== b.workspaceId) throw notFound('Template not found')
    doc = withFreshIds(tpl.doc, id)
    doc.name = b.name || tpl.name.replace(/ \(template\)$/i, '')
  } else {
    doc = createProject({ id, name: b.name || 'Untitled project', width: b.width, height: b.height, fps: b.fps })
  }
  const row = await insertProject({ workspaceId: b.workspaceId, userId: u.id, doc, kind: b.kind })
  announce(row)
  const res: ProjectDocResponse = { summary: projectSummary(row), project: row.doc, version: row.version }
  return c.json(res)
})

projectRoutes.get('/:id', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  const res: ProjectDocResponse = { summary: projectSummary(row), project: await hydrateAssets(row.doc, row.workspaceId), version: row.version }
  return c.json(res)
})

projectRoutes.put('/:id', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  const row = await loadProjectRow(id)
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, z.object({ project: z.unknown(), baseVersion: z.number().int() }))
  const doc = validateProject(b.project)
  if (doc.id !== id) throw invalid('project.id does not match the URL')
  const r = await saveProjectDoc(id, doc, b.baseVersion)
  return c.json({ version: r.version, updatedAt: r.updatedAt })
})

projectRoutes.patch('/:id', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  const row = await loadProjectRow(id)
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, z.object({ name: z.string().trim().min(1).max(200).optional(), trashed: z.boolean().optional(), isTemplate: z.boolean().optional() }))
  const now = Date.now()
  const set: PgUpdateSetSource<typeof projects> = { updatedAt: now }
  if (b.name !== undefined) {
    // one statement on the stored row: a save landing after our read is kept, and its version is never reused
    set.name = b.name
    set.doc = sql`jsonb_set(jsonb_set(${projects.doc}, '{name}', to_jsonb(${b.name}::text)), '{updatedAt}', to_jsonb(${now}::bigint))`
    set.version = sql`${projects.version} + 1`
  }
  if (b.trashed !== undefined) set.trashedAt = b.trashed ? now : null
  if (b.isTemplate !== undefined) set.isTemplate = b.isTemplate
  const [updated] = await ctx().db.update(projects).set(set).where(eq(projects.id, id)).returning()
  // trash, restore and template changes keep the version but still change what other screens list
  announce(updated)
  return c.json({ ...projectSummary(updated), version: updated.version })
})

projectRoutes.post('/:id/duplicate', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const doc = withFreshIds(row.doc, uid('p'))
  doc.name = `${row.name} copy`
  const copy = await insertProject({ workspaceId: row.workspaceId, userId: u.id, doc, kind: row.kind })
  announce(copy)
  return c.json(projectSummary(copy))
})

projectRoutes.delete('/:id', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  if (row.trashedAt == null) throw new HttpError(409, 'conflict', 'Move the project to the trash before deleting it')
  await ctx().db.delete(projects).where(eq(projects.id, row.id))
  announce(row, true)
  return c.json({ ok: true })
})
