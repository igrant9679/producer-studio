// Who has a project open now (A-23). Each open editor tab says so every PRESENCE_BEAT_MS and says goodbye when it
// closes; a tab that stops beating is gone after PRESENCE_TTL_MS. Kept in Postgres (the presence table), so every API
// process sees every visitor; every change in who is there goes out as a `presence` event on the space's stream, to
// other processes too. Whichever process sweeps a tab that stopped beating tells the space.
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import type { PresenceEntry, ProjectPresence, Role } from '@producer/core'
import { PRESENCE_TTL_MS } from '@producer/core'
import { ctx } from '../context'
import { presenceRows } from '../db/schema'
import { log } from '../log'

type Row = typeof presenceRows.$inferSelect

let sweeper: ReturnType<typeof setInterval> | undefined

function people(rows: Row[]): PresenceEntry[] {
  const byUser = new Map<string, PresenceEntry>()
  for (const t of rows) {
    const cur = byUser.get(t.userId)
    if (!cur) byUser.set(t.userId, { userId: t.userId, name: t.name, color: t.color, role: t.role as Role, since: t.since })
    else cur.since = Math.min(cur.since, t.since)
  }
  return [...byUser.values()].sort((a, b) => a.since - b.since || a.userId.localeCompare(b.userId))
}

const signature = (rows: Row[]) => people(rows).map((p) => `${p.userId}:${p.role}`).join(',')

async function liveRows(projectId: string, now = Date.now()): Promise<Row[]> {
  return ctx()
    .db.select()
    .from(presenceRows)
    .where(and(eq(presenceRows.projectId, projectId), gt(presenceRows.seen, now - PRESENCE_TTL_MS)))
}

export async function presenceOf(projectId: string, now = Date.now()): Promise<ProjectPresence> {
  return { projectId, people: people(await liveRows(projectId, now)) }
}

function announce(p: ProjectPresence, workspaceId: string) {
  // who is here now: not worth replaying to a stream that reconnects (it asks again); small, so it travels inline
  ctx().bus.publish(workspaceId, 'presence', p, { id: p.projectId, inline: p, replay: false })
}

/** Drop tabs that stopped beating (in any process); tell each space whose project that changed. */
export async function sweepPresence(now = Date.now()) {
  const gone = await ctx()
    .db.delete(presenceRows)
    .where(lte(presenceRows.seen, now - PRESENCE_TTL_MS))
    .returning({ projectId: presenceRows.projectId, workspaceId: presenceRows.workspaceId })
  const projects = new Map(gone.map((g) => [g.projectId, g.workspaceId]))
  if (projects.size) {
    const still = await ctx().db.select().from(presenceRows).where(inArray(presenceRows.projectId, [...projects.keys()]))
    for (const [projectId, workspaceId] of projects) announce({ projectId, people: people(still.filter((r) => r.projectId === projectId && r.seen > now - PRESENCE_TTL_MS)) }, workspaceId)
  }
  const [any] = await ctx().db.select({ p: presenceRows.projectId }).from(presenceRows).limit(1)
  if (!any && sweeper) {
    clearInterval(sweeper)
    sweeper = undefined
  }
}

/** A tab's heartbeat (`open`) or goodbye. Returns who is there now. */
export async function beat(project: { id: string; workspaceId: string }, user: { id: string; name: string; avatarColor: string }, role: Role, client: string, open: boolean, now = Date.now()): Promise<ProjectPresence> {
  const db = ctx().db
  const before = signature(await liveRows(project.id, now))
  // one person's tabs can't stand in for, or close, anyone else's: a tab is (project, person, client)
  const tab = and(eq(presenceRows.projectId, project.id), eq(presenceRows.userId, user.id), eq(presenceRows.client, client))
  if (open) {
    await db
      .insert(presenceRows)
      .values({ projectId: project.id, userId: user.id, client, workspaceId: project.workspaceId, name: user.name, color: user.avatarColor, role, since: now, seen: now })
      // a tab back after it had timed out (not swept yet) starts a new visit
      .onConflictDoUpdate({ target: [presenceRows.projectId, presenceRows.userId, presenceRows.client], set: { seen: now, role, name: user.name, color: user.avatarColor, since: sql`CASE WHEN ${presenceRows.seen} <= ${now - PRESENCE_TTL_MS} THEN ${now} ELSE ${presenceRows.since} END` } })
  } else await db.delete(presenceRows).where(tab)
  const rows = await liveRows(project.id, now)
  const out = { projectId: project.id, people: people(rows) }
  if (signature(rows) !== before) announce(out, project.workspaceId)
  if (open && !sweeper) {
    sweeper = setInterval(() => void sweepPresence().catch((err) => log.warn('presence sweep failed', { err })), 10_000)
    sweeper.unref?.()
  }
  return out
}

/** Tests: forget everyone. */
export async function resetPresence() {
  await ctx().db.delete(presenceRows)
  if (sweeper) clearInterval(sweeper)
  sweeper = undefined
}
