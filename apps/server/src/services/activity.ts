// The per-space activity feed (A-23): one row per thing that happened (created, renamed, exported, shared, commented,
// member changes). Recording never fails the request that did the thing: a lost row is logged, not thrown.
import type { ActivityEntry, ActivityKind } from '@producer/core'
import { eq } from 'drizzle-orm'
import { ctx } from '../context'
import { activity, users } from '../db/schema'
import { newId } from '../ids'
import { log } from '../log'

export interface ActivityInput {
  workspaceId: string
  projectId?: string | null
  /** Who did it: a user id (their name is looked up), or a share-page visitor's name. */
  actorId?: string | null
  actorName?: string
  kind: ActivityKind
  data?: Record<string, unknown>
}

let last = 0

/** Recorded in order: two things in the same millisecond still list newest first. */
export async function recordActivity(e: ActivityInput): Promise<void> {
  const at = (last = Math.max(Date.now(), last + 0.001))
  try {
    let name = e.actorName
    if (!name && e.actorId) name = (await ctx().db.select({ name: users.name }).from(users).where(eq(users.id, e.actorId)).limit(1))[0]?.name
    await ctx()
      .db.insert(activity)
      .values({ id: newId('act'), workspaceId: e.workspaceId, projectId: e.projectId ?? null, actorId: e.actorId ?? null, actorName: name || 'Someone', kind: e.kind, data: e.data ?? {}, createdAt: at })
  } catch (err) {
    log.warn('activity not recorded', { kind: e.kind, err })
  }
}

export function activityDto(r: typeof activity.$inferSelect): ActivityEntry {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    ...(r.projectId ? { projectId: r.projectId } : {}),
    actor: { ...(r.actorId ? { id: r.actorId } : {}), name: r.actorName },
    kind: r.kind as ActivityKind,
    data: r.data ?? {},
    createdAt: r.createdAt,
  }
}
