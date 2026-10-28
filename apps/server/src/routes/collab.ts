// Collaboration routes (E-22, A-23): a project's review comments for its members, who has it open, and a space's
// activity feed. The share page's comments are in routes/share.ts; the contract is in packages/core/src/collab.ts.
import { Hono } from 'hono'
import { and, eq, or } from 'drizzle-orm'
import * as z from 'zod/v4'
import { COMMENT_MAX } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { activity, comments } from '../db/schema'
import { HttpError, body, requireRole, roleAtLeast } from '../http'
import { afterCursor, pageOrder, pageQuery, toPage } from '../paging'
import { activityDto } from '../services/activity'
import { addComment, announceComment, commentDtos, loadComment, NewCommentSchema, projectComments } from '../services/comments'
import { beat, presenceOf } from '../services/presence'
import { loadProjectRow } from '../services/projects'

/** Mounted at /api/projects. */
export const projectCollabRoutes = new Hono<AppEnv>()

projectCollabRoutes.get('/:id/comments', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  const role = await requireRole(u.id, row.workspaceId, 'viewer')
  return c.json(await commentDtos(await projectComments(row.id), { userId: u.id, moderator: roleAtLeast(role, 'editor') }))
})

/** Viewers comment too: reviewing is what a viewer is for. */
projectCollabRoutes.post('/:id/comments', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  const role = await requireRole(u.id, row.workspaceId, 'viewer')
  const b = await body(c, NewCommentSchema)
  const created = await addComment(row, b, { userId: u.id, name: u.name })
  const [dto] = await commentDtos([created], { userId: u.id, moderator: roleAtLeast(role, 'editor') })
  announceComment(row.workspaceId, { projectId: row.id, comment: dto })
  return c.json(dto)
})

projectCollabRoutes.get('/:id/presence', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  return c.json(presenceOf(row.id))
})

/** An open editor's heartbeat (`open: true`) or goodbye (`open: false`), per browser tab (`client`). */
projectCollabRoutes.post('/:id/presence', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  const role = await requireRole(u.id, row.workspaceId, 'viewer')
  const b = await body(c, z.object({ client: z.string().min(1).max(64), open: z.boolean().default(true) }))
  return c.json(beat(row, u, role, b.client, b.open))
})

/** Mounted at /api/comments. */
export const commentRoutes = new Hono<AppEnv>()

/** Resolve or reopen (editors and the author), or change the words (the author). */
commentRoutes.patch('/:id', async (c) => {
  const u = requireUser(c)
  const cm = await loadComment(c.req.param('id'))
  const role = await requireRole(u.id, cm.workspaceId, 'viewer')
  const moderator = roleAtLeast(role, 'editor')
  const mine = cm.authorId === u.id
  const b = await body(c, z.object({ body: z.string().trim().min(1).max(COMMENT_MAX).optional(), resolved: z.boolean().optional() }))
  const now = Date.now()
  const set: Partial<typeof comments.$inferSelect> = { updatedAt: now }
  if (b.body !== undefined) {
    if (!mine) throw new HttpError(403, 'forbidden', 'Only the person who wrote a comment can change it.')
    set.body = b.body
  }
  if (b.resolved !== undefined) {
    if (!mine && !moderator) throw new HttpError(403, 'forbidden', 'Only editors of this space, or whoever wrote it, can resolve a comment.')
    if (cm.parentId) throw new HttpError(400, 'invalid', 'Resolve the thread from its first comment.')
    set.resolvedAt = b.resolved ? now : null
    set.resolvedBy = b.resolved ? u.name : null
  }
  const [updated] = await ctx().db.update(comments).set(set).where(eq(comments.id, cm.id)).returning()
  const [dto] = await commentDtos([updated], { userId: u.id, moderator })
  announceComment(cm.workspaceId, { projectId: cm.projectId, comment: dto })
  return c.json(dto)
})

/** Remove a comment (its author or an editor); a thread's first comment takes its replies with it. */
commentRoutes.delete('/:id', async (c) => {
  const u = requireUser(c)
  const cm = await loadComment(c.req.param('id'))
  const role = await requireRole(u.id, cm.workspaceId, 'viewer')
  if (cm.authorId !== u.id && !roleAtLeast(role, 'editor')) throw new HttpError(403, 'forbidden', 'Only editors of this space, or whoever wrote it, can remove a comment.')
  const gone = await ctx()
    .db.delete(comments)
    .where(cm.parentId ? eq(comments.id, cm.id) : and(eq(comments.projectId, cm.projectId), or(eq(comments.id, cm.id), eq(comments.parentId, cm.id))))
    .returning({ id: comments.id })
  announceComment(cm.workspaceId, { projectId: cm.projectId, removed: gone.map((g) => g.id) })
  return c.json({ ok: true, removed: gone.map((g) => g.id) })
})

/** Mounted at /api/workspaces: the space's activity, newest first, in pages. */
export const activityRoutes = new Hono<AppEnv>()

activityRoutes.get('/:id/activity', async (c) => {
  const u = requireUser(c)
  const wsId = c.req.param('id')
  await requireRole(u.id, wsId, 'viewer')
  const { limit, after } = pageQuery(c)
  const rows = await ctx()
    .db.select()
    .from(activity)
    .where(and(eq(activity.workspaceId, wsId), afterCursor(activity.createdAt, activity.id, after)))
    .orderBy(...pageOrder(activity.createdAt, activity.id))
    .limit(Math.min(limit, 100) + 1)
  return c.json(toPage(rows, Math.min(limit, 100), (r) => [r.createdAt, r.id], activityDto))
})
