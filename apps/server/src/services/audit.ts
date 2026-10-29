// The security audit log (P-8): sign-ins, account and access changes, invites, roles and hand-overs, AI keys, deletes
// and every operator action, with who, when, from which address and browser, and the request id. Space owners read
// their space's entries (the Audit tab); operators read all of them. Writing an entry never fails the request that
// did the thing: a lost entry is logged, not thrown.
import type { Context } from 'hono'
import { type SQL, and, eq, ilike, inArray, or } from 'drizzle-orm'
import type { AuditEntry, AuditKind } from '@producer/core'
import { type AppEnv, clientIp } from '../auth'
import { ctx } from '../context'
import { auditLog } from '../db/schema'
import { newId } from '../ids'
import { log } from '../log'
import { afterCursor, pageOrder, toPage } from '../paging'
import { requestIdOf } from '../request-id'

export interface AuditInput {
  kind: AuditKind
  /** Who did it; null for someone not signed in (a failed sign-in, a reset request). */
  actor?: { id: string; email: string } | null
  workspaceId?: string | null
  targetId?: string | null
  /** The target in words: an email, a member's name, a job. */
  target?: string | null
  data?: Record<string, unknown>
}

let last = 0

/** Write one entry (in order: two in the same millisecond still list newest first). */
export async function audit(c: Context<AppEnv> | null, e: AuditInput): Promise<void> {
  const at = (last = Math.max(Date.now(), last + 0.001))
  try {
    const actor = e.actor === undefined ? (c?.get('user') ?? null) : e.actor
    await ctx()
      .db.insert(auditLog)
      .values({
        id: newId('au'),
        at,
        kind: e.kind,
        actorId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        workspaceId: e.workspaceId ?? null,
        targetId: e.targetId ?? null,
        target: e.target?.slice(0, 300) ?? null,
        ip: c ? clientIp(c) : null,
        userAgent: c?.req.header('user-agent')?.slice(0, 200) ?? null,
        requestId: c ? requestIdOf(c) || null : null,
        data: e.data ?? {},
      })
  } catch (err) {
    log.warn('audit entry not recorded', { kind: e.kind, err })
  }
}

export function auditDto(r: typeof auditLog.$inferSelect): AuditEntry {
  return {
    id: r.id,
    at: r.at,
    kind: r.kind as AuditKind,
    ...(r.actorId ? { actor: { id: r.actorId, ...(r.actorEmail ? { email: r.actorEmail } : {}) } } : {}),
    ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
    ...(r.target ? { target: r.target } : {}),
    ...(r.targetId ? { targetId: r.targetId } : {}),
    ...(r.ip ? { ip: r.ip } : {}),
    ...(r.userAgent ? { userAgent: r.userAgent } : {}),
    ...(r.requestId ? { requestId: r.requestId } : {}),
    data: r.data ?? {},
  }
}

export interface AuditQuery {
  workspaceId?: string
  /** Entries done by, or to, this user. */
  userId?: string
  kinds?: readonly string[]
  /** Email, target or kind contains this. */
  q?: string
  limit: number
  after?: { t: number; id: string }
}

/** A page of entries, newest first. */
export async function listAudit(o: AuditQuery) {
  const conds: Array<SQL | undefined> = []
  if (o.workspaceId) conds.push(eq(auditLog.workspaceId, o.workspaceId))
  if (o.userId) conds.push(or(eq(auditLog.actorId, o.userId), eq(auditLog.targetId, o.userId)))
  if (o.kinds?.length) conds.push(inArray(auditLog.kind, [...o.kinds]))
  if (o.q) {
    const like = `%${o.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    conds.push(or(ilike(auditLog.actorEmail, like), ilike(auditLog.target, like), ilike(auditLog.kind, like), eq(auditLog.requestId, o.q), eq(auditLog.ip, o.q)))
  }
  conds.push(afterCursor(auditLog.at, auditLog.id, o.after))
  const rows = await ctx()
    .db.select()
    .from(auditLog)
    .where(and(...conds))
    .orderBy(...pageOrder(auditLog.at, auditLog.id))
    .limit(o.limit + 1)
  return toPage(rows, o.limit, (r) => [r.at, r.id], auditDto)
}
