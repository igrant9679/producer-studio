// Timecoded review comments (E-22). A thread is a first comment pinned to a time (and maybe a point on the frame)
// with replies; members comment from the editor, share-page visitors with a name when the link allows it. Every
// change goes out on the workspace's live stream as a `comment` event, so open editors update.
import type { NewComment, ReviewComment } from '@producer/core'
import { COMMENT_MAX, COMMENT_NAME_MAX } from '@producer/core'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import * as z from 'zod/v4'
import { ctx } from '../context'
import { comments, users } from '../db/schema'
import { HttpError, invalid, notFound } from '../http'
import { newId } from '../ids'
import { recordActivity } from './activity'

export type CommentRow = typeof comments.$inferSelect

export const NewCommentSchema = z.object({
  body: z.string().trim().min(1, 'Write something first').max(COMMENT_MAX),
  at: z.number().min(0).max(1e6).optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  parentId: z.string().max(100).optional(),
  name: z.string().trim().min(1).max(COMMENT_NAME_MAX).optional(),
})

/** A visitor's colour: one of a few, from their name, so the same name keeps it. */
function guestColor(name: string): string {
  const palette = ['#7c8cff', '#35e0ff', '#ffc24d', '#ff7aa8', '#5be49b', '#c38bff']
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

export interface Asker {
  userId?: string
  /** An editor or owner of the space: resolves and removes anyone's. */
  moderator: boolean
}

export async function commentDtos(rows: CommentRow[], asker: Asker, offset = 0): Promise<ReviewComment[]> {
  const ids = [...new Set(rows.map((r) => r.authorId).filter((x): x is string => !!x))]
  const people = ids.length ? await ctx().db.select({ id: users.id, color: users.avatarColor, name: users.name }).from(users).where(inArray(users.id, ids)) : []
  const byId = new Map(people.map((p) => [p.id, p]))
  return rows.map((r) => commentDto(r, asker, offset, r.authorId ? byId.get(r.authorId) : undefined))
}

function commentDto(r: CommentRow, asker: Asker, offset: number, person?: { color: string; name: string }): ReviewComment {
  const mine = !!asker.userId && r.authorId === asker.userId
  return {
    id: r.id,
    projectId: r.projectId,
    ...(r.parentId ? { parentId: r.parentId } : {}),
    author: { ...(r.authorId ? { id: r.authorId } : {}), name: person?.name ?? r.authorName, color: person?.color ?? guestColor(r.authorName), guest: !r.authorId },
    body: r.body,
    ...(r.at != null ? { at: Math.max(0, r.at - offset) } : {}),
    ...(r.x != null && r.y != null ? { x: r.x, y: r.y } : {}),
    ...(r.resolvedAt != null ? { resolved: { at: r.resolvedAt, ...(r.resolvedBy ? { by: r.resolvedBy } : {}) } } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    canEdit: mine,
    canDelete: mine || asker.moderator,
  }
}

export async function projectComments(projectId: string): Promise<CommentRow[]> {
  return ctx().db.select().from(comments).where(eq(comments.projectId, projectId)).orderBy(asc(comments.createdAt)).limit(2000)
}

export async function loadComment(id: string): Promise<CommentRow> {
  const r = (await ctx().db.select().from(comments).where(eq(comments.id, id)).limit(1))[0]
  if (!r) throw notFound('This comment was removed')
  return r
}

/** Tell the space's open editors. */
export function announceComment(workspaceId: string, data: { projectId: string; comment?: ReviewComment; removed?: string[] }) {
  ctx().bus.publish(workspaceId, 'comment', data)
}

/**
 * Add a comment (or a reply) to a project. `offset` turns a time in a shared export of a range into project time.
 * A reply joins its thread's first comment and has no time of its own.
 */
export async function addComment(
  project: { id: string; workspaceId: string; name: string },
  b: NewComment,
  author: { userId?: string; name: string; shareToken?: string },
  offset = 0,
): Promise<CommentRow> {
  let parentId: string | null = null
  if (b.parentId) {
    const parent = await loadComment(b.parentId).catch(() => null)
    if (!parent || parent.projectId !== project.id) throw invalid('That thread is not on this project')
    parentId = parent.parentId ?? parent.id
  }
  const now = Date.now()
  const row: CommentRow = {
    id: newId('cm'),
    projectId: project.id,
    workspaceId: project.workspaceId,
    parentId,
    authorId: author.userId ?? null,
    authorName: author.name.slice(0, COMMENT_NAME_MAX),
    shareToken: author.shareToken ?? null,
    body: b.body,
    at: parentId || b.at === undefined ? null : b.at + offset,
    x: parentId || b.x === undefined || b.y === undefined ? null : b.x,
    y: parentId || b.x === undefined || b.y === undefined ? null : b.y,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: now,
    updatedAt: now,
  }
  const [count] = await ctx().db.select({ n: sql<number>`count(*)::int` }).from(comments).where(eq(comments.projectId, project.id))
  if (Number(count?.n ?? 0) >= 2000)
    throw new HttpError(429, 'quota', 'This project has as many comments as it can hold. Resolve and remove some first.')
  await ctx().db.insert(comments).values(row)
  await recordActivity({ workspaceId: project.workspaceId, projectId: project.id, actorId: author.userId, actorName: author.userId ? undefined : author.name, kind: 'comment.added', data: { project: project.name, reply: !!parentId, guest: !author.userId } })
  return row
}
