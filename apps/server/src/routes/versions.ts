// Version history routes (P-15), mounted at /api/projects: list, read, name and restore a project's saved versions.
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import type { ProjectVersionResponse } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { projectVersions, users } from '../db/schema'
import { body, notFound, requireRole } from '../http'
import { hydrateAssets, loadProjectRow, saveProjectDoc, validateProject } from '../services/projects'
import { listVersions, loadVersion, recordVersion, versionAt, versionSummary, type VersionRow } from '../services/versions'

export const versionRoutes = new Hono<AppEnv>()

async function authorName(id: string | null): Promise<string | null> {
  if (!id) return null
  return (await ctx().db.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1))[0]?.name ?? null
}

async function response(v: VersionRow, currentVersion: number, workspaceId: string): Promise<ProjectVersionResponse> {
  return { summary: versionSummary({ ...v, authorName: await authorName(v.createdBy) }, v.version === currentVersion), project: await hydrateAssets(v.doc, workspaceId) }
}

versionRoutes.get('/:id/versions', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  return c.json(await listVersions(row.id, row.version))
})

/** The version holding a given project version (the editor's base for merging edits kept in this browser). */
versionRoutes.get('/:id/versions/at/:version', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  const v = await versionAt(row.id, Number(c.req.param('version')))
  if (!v) throw notFound('That version is no longer in the history')
  return c.json(await response(v, row.version, row.workspaceId))
})

versionRoutes.get('/:id/versions/:vid', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  const v = await loadVersion(row.id, c.req.param('vid'))
  if (!v) throw notFound('Version not found')
  return c.json(await response(v, row.version, row.workspaceId))
})

const NameSchema = z.object({ name: z.string().trim().min(1).max(120) })

/** Name what's saved now ("Sent to client"): a named version is never thinned away. */
versionRoutes.post('/:id/versions', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, NameSchema)
  const at = await versionAt(row.id, row.version)
  let v: VersionRow | null
  if (at) [v] = await ctx().db.update(projectVersions).set({ label: 'named', name: b.name }).where(eq(projectVersions.id, at.id)).returning()
  else v = await recordVersion(row, { userId: u.id, label: 'named', name: b.name })
  if (!v) throw new Error('Could not keep the version')
  return c.json(versionSummary({ ...v, authorName: await authorName(v.createdBy) }, true))
})

/** Name, rename or (name: null) unname a version. */
versionRoutes.patch('/:id/versions/:vid', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, z.object({ name: z.string().trim().min(1).max(120).nullable() }))
  const v = await loadVersion(row.id, c.req.param('vid'))
  if (!v) throw notFound('Version not found')
  const label = b.name ? 'named' : v.label === 'named' ? 'autosave' : v.label
  const [out] = await ctx().db.update(projectVersions).set({ name: b.name, label }).where(eq(projectVersions.id, v.id)).returning()
  return c.json(versionSummary({ ...out, authorName: await authorName(out.createdBy) }, out.version === row.version))
})

/**
 * Bring a version back. It is saved as a new version on top of the current one (409 when `baseVersion` is given and
 * another save landed since), and what it replaces is kept as "before restore". The Producer AI record stays the
 * stored one, as for any save.
 */
versionRoutes.post('/:id/versions/:vid/restore', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, z.object({ baseVersion: z.number().int().optional() }))
  const v = await loadVersion(row.id, c.req.param('vid'))
  if (!v) throw notFound('Version not found')
  const doc = validateProject({ ...v.doc, id: row.id })
  if (row.doc.ai) doc.ai = row.doc.ai
  else delete doc.ai
  const r = await saveProjectDoc(row.id, doc, b.baseVersion ?? row.version, { userId: u.id, before: 'before-restore', note: `Restored from version ${v.version}` })
  return c.json({ version: r.version, updatedAt: r.updatedAt })
})
