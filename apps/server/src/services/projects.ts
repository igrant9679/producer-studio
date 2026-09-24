// Project persistence helpers shared by routes and jobs (save with optimistic concurrency, hydrate assets).
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import * as z from 'zod/v4'
import { projectDuration, uid, type Project } from '@producer/core'
import { ctx } from '../context'
import { assets, projects } from '../db/schema'
import { assetDoc, projectSummary } from '../dto'
import { HttpError, invalid, notFound } from '../http'

export type ProjectRow = typeof projects.$inferSelect

const ItemShape = z.looseObject({ id: z.string().min(1), type: z.enum(['video', 'image', 'audio', 'text', 'caption', 'shape']), start: z.number().min(0), duration: z.number().positive() })
const TrackShape = z.looseObject({ id: z.string().min(1), kind: z.enum(['video', 'overlay', 'text', 'audio', 'caption']), name: z.string(), items: z.array(ItemShape) })
export const ProjectShape = z.looseObject({
  id: z.string().min(1),
  schema: z.literal(1),
  name: z.string().max(200),
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  fps: z.number().min(1).max(240),
  background: z.string().max(100),
  tracks: z.array(TrackShape).max(200),
  assets: z.record(z.string(), z.looseObject({ id: z.string(), kind: z.enum(['video', 'audio', 'image']) })),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export function validateProject(doc: unknown): Project {
  const r = ProjectShape.safeParse(doc)
  if (!r.success) {
    const i = r.error.issues[0]
    throw invalid(`Invalid project: ${i.path.join('.')}: ${i.message}`, r.error.issues.slice(0, 5))
  }
  const p = doc as Project
  const ids = new Set<string>()
  for (const t of p.tracks) for (const it of t.items) {
    if (ids.has(it.id)) throw invalid(`Invalid project: duplicate item id ${it.id}`)
    ids.add(it.id)
  }
  return p
}

export async function loadProjectRow(id: string): Promise<ProjectRow> {
  const row = (await ctx().db.select().from(projects).where(eq(projects.id, id)).limit(1))[0]
  if (!row) throw notFound('Project not found')
  return row
}

/** Refresh embedded asset records from the assets table (proxy/filmstrip/transcript may have arrived later). */
export async function hydrateAssets(p: Project, workspaceId: string): Promise<Project> {
  const ids = Object.keys(p.assets ?? {})
  if (!ids.length) return p
  const rows = await ctx()
    .db.select()
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, ids)))
  if (!rows.length) return p
  const next = { ...p, assets: { ...p.assets } }
  for (const r of rows) {
    const fresh = assetDoc(r)
    // keep a doc-only transcript (e.g. estimated word timings for generated voice) when the DB has none
    next.assets[r.id] = fresh.transcript || !p.assets[r.id]?.transcript ? fresh : { ...fresh, transcript: p.assets[r.id].transcript }
  }
  return next
}

async function deriveThumbnail(p: Project, workspaceId: string): Promise<string | null> {
  const ordered = [...p.tracks.filter((t) => t.main), ...p.tracks.filter((t) => !t.main)]
  const candidates: string[] = []
  for (const t of ordered) for (const it of t.items) if ((it.type === 'video' || it.type === 'image') && !candidates.includes(it.assetId)) candidates.push(it.assetId)
  if (!candidates.length) return null
  const rows = await ctx()
    .db.select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, candidates.slice(0, 20)), isNotNull(assets.thumbKey)))
  const have = new Set(rows.map((r) => r.id))
  return candidates.find((c) => have.has(c)) ?? null
}

export function derived(p: Project) {
  return { name: p.name.slice(0, 200) || 'Untitled project', width: Math.round(p.width), height: Math.round(p.height), duration: projectDuration(p) }
}

/**
 * Save a project document. With baseVersion, fails with 409 if another save won; without it (server-side jobs),
 * writes unconditionally. Bumps version and emits a `project` event.
 */
export async function saveProjectDoc(id: string, doc: Project, baseVersion?: number): Promise<{ version: number; updatedAt: number; row: ProjectRow }> {
  const row = await loadProjectRow(id)
  const p = validateProject({ ...doc, id })
  const now = Date.now()
  const thumbnail = await deriveThumbnail(p, row.workspaceId)
  const cond = baseVersion === undefined ? eq(projects.id, id) : and(eq(projects.id, id), eq(projects.version, baseVersion))
  const nextVersion = (baseVersion ?? row.version) + 1
  const updated = await ctx()
    .db.update(projects)
    .set({ doc: { ...p, updatedAt: now }, version: baseVersion === undefined ? row.version + 1 : nextVersion, ...derived(p), thumbnail, updatedAt: now })
    .where(cond)
    .returning()
  if (!updated.length) {
    const cur = await loadProjectRow(id)
    // details carry the current document so replicas can merge or keep both
    throw new HttpError(409, 'conflict', 'The project was changed elsewhere. Reload to get the latest version.', {
      version: cur.version,
      project: await hydrateAssets(cur.doc, cur.workspaceId),
      summary: projectSummary(cur),
    })
  }
  const r = updated[0]
  ctx().bus.publish(r.workspaceId, 'project', { id: r.id, version: r.version }, { id: r.id, inline: { id: r.id, version: r.version } })
  return { version: r.version, updatedAt: now, row: r }
}

/** Deep copy with fresh project/track/item ids (asset ids kept; link ids remapped consistently). */
export function withFreshIds(p: Project, newProjectId: string): Project {
  const copy = structuredClone(p)
  copy.id = newProjectId
  const links = new Map<string, string>()
  for (const t of copy.tracks) {
    t.id = uid('t')
    for (const it of t.items) {
      it.id = uid(it.type === 'video' ? 'v' : it.type === 'audio' ? 'a' : it.type === 'text' ? 'x' : it.type === 'caption' ? 'c' : it.type === 'image' ? 'm' : 's')
      if (it.linkId) {
        if (!links.has(it.linkId)) links.set(it.linkId, uid('l'))
        it.linkId = links.get(it.linkId)
      }
    }
  }
  const now = Date.now()
  copy.createdAt = now
  copy.updatedAt = now
  return copy
}

export async function insertProject(opts: { workspaceId: string; userId: string; doc: Project; kind?: string; isTemplate?: boolean }): Promise<ProjectRow> {
  const now = Date.now()
  const p = validateProject(opts.doc)
  const [row] = await ctx()
    .db.insert(projects)
    .values({
      id: p.id,
      workspaceId: opts.workspaceId,
      kind: opts.kind ?? 'edit',
      doc: p,
      version: 1,
      ...derived(p),
      thumbnail: await deriveThumbnail(p, opts.workspaceId),
      isTemplate: opts.isTemplate ?? false,
      createdBy: opts.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row
}

export { projectSummary }
