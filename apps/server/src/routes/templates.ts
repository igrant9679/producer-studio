import fs from 'node:fs'
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { projectDuration, type Project, type TemplateSummary } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { projects } from '../db/schema'
import { mediaPath } from '../dto'
import { notFound, requireRole } from '../http'
import { getLook, loadLooks, starterProject } from '../services/looks'
import { afterCursor, pageOrder, pageQuery, toPage } from '../paging'

export const templateRoutes = new Hono<AppEnv>()

function counts(p: Project) {
  let clips = 0
  let texts = 0
  for (const t of p.tracks)
    for (const it of t.items) {
      if (it.type === 'video' || it.type === 'image' || it.type === 'audio') clips++
      if (it.type === 'text' || it.type === 'caption') texts++
    }
  return { clipCount: clips, textCount: texts }
}

function aspectOf(w: number, h: number): string {
  const r = w / h
  const known: Array<[string, number]> = [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:5', 4 / 5], ['4:3', 4 / 3], ['3:4', 3 / 4], ['21:9', 21 / 9]]
  return known.reduce((best, k) => (Math.abs(k[1] - r) < Math.abs(best[1] - r) ? k : best), known[0])[0]
}

function builtInSummary(l: ReturnType<typeof loadLooks>[number]): TemplateSummary {
  const p = starterProject(l)
  return {
    id: `tpl:${l.id}`,
    name: l.name,
    category: l.category,
    aspect: l.aspect,
    duration: projectDuration(p),
    thumbnailUrl: l.previewPath ? `/api/templates/tpl:${l.id}/preview` : undefined,
    previewUrl: undefined,
    builtIn: true,
    ...counts(p),
  }
}

templateRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const { limit, after } = pageQuery(c)
  // the built-in looks come first, on the first page; the workspace's templates are paged after them
  const out: TemplateSummary[] = after ? [] : loadLooks().map(builtInSummary)
  const workspaceId = c.req.query('workspaceId')
  let nextCursor: string | undefined
  if (workspaceId) {
    await requireRole(u.id, workspaceId, 'viewer')
    const rows = await ctx()
      .db.select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.isTemplate, true), isNull(projects.trashedAt), afterCursor(projects.updatedAt, projects.id, after)))
      .orderBy(...pageOrder(projects.updatedAt, projects.id))
      .limit(limit + 1)
    const page = toPage(rows, limit, (r) => [r.updatedAt, r.id], (r) => r)
    nextCursor = page.nextCursor
    for (const r of page.items)
      out.push({
        id: r.id,
        name: r.name,
        category: 'My templates',
        aspect: aspectOf(r.width, r.height),
        duration: r.duration,
        thumbnailUrl: r.thumbnail ? mediaPath(r.thumbnail, 'thumb') : undefined,
        builtIn: false,
        ...counts(r.doc),
      })
  }
  return c.json({ items: out, ...(nextCursor ? { nextCursor } : {}) })
})

// Built-in look preview image (from the producer-pipeline skill). Public: contains no user data.
templateRoutes.get('/:id/preview', (c) => {
  const id = c.req.param('id').replace(/^tpl:/, '')
  const look = getLook(id)
  if (look.id !== id || !look.previewPath || !fs.existsSync(look.previewPath)) throw notFound('No preview for this template')
  const buf = fs.readFileSync(look.previewPath)
  return new Response(buf, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } })
})
