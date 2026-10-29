// Housekeeping: rows that can never be used again are deleted, so these tables don't grow forever.
// Runs in the worker a few minutes after start, then every 6 hours. Nothing a person can still act on is touched.
// Each kept-for setting is an env value in days, 0 = keep forever (P-11): JOB_RETENTION_DAYS (finished jobs, 30),
// TOMBSTONE_RETENTION_DAYS (sync tombstones, 90), AUDIT_RETENTION_DAYS (the audit log, 365). Rate windows past their
// reset and old usage rows go in services/metering.ts (pruneUsage); temp and render folders in sweepTempDirs.
import { and, inArray, isNotNull, lt, or } from 'drizzle-orm'
import { INVITE_TTL_MS, PRESENCE_TTL_MS } from '@producer/core'
import { ctx } from '../context'
import { auditLog, authTokens, invites, jobs, presenceRows, sessions } from '../db/schema'
import { log } from '../log'
import { sweepLibrary } from './library'
import { compactTombstones, syncHorizon } from './tombstones'

const DAY = 24 * 3600 * 1000
const HOUR = 3600 * 1000
/** Used, withdrawn and expired invites are kept this long (an invitee opening an old link still gets a clear answer). */
export const INVITE_RETENTION_MS = 30 * DAY
/** Reset and confirmation tokens are kept a day past their expiry (a late click still gets "expired", not "unknown"). */
export const TOKEN_RETENTION_MS = DAY

/**
 * The highest change number whose tombstone may be gone (0: none yet): the sync feed's horizon (services/tombstones.ts,
 * raised by a trigger whenever a tombstone is deleted). A desktop that last synced below it is told to resync in full.
 */
export const tombstoneHorizon = syncHorizon

/** Tombstones older than TOMBSTONE_RETENTION_DAYS, cloud only (a desktop's own tombstones are what it still has to push). */
async function pruneTombstones(): Promise<number> {
  const cfg = ctx().config
  if (cfg.mode !== 'cloud' || !cfg.retention.tombstoneDays) return 0
  return compactTombstones(cfg.retention.tombstoneDays)
}

export async function pruneOldRows(now = Date.now()): Promise<{ sessions: number; jobs: number; invites: number; tokens: number; tombstones: number; audit: number; presence: number }> {
  const db = ctx().db
  const { retention } = ctx().config
  const s = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id })
  // the hourly send limits count tokens made in the last hour, so a token goes only once it's old for both
  const tk = await db
    .delete(authTokens)
    .where(and(lt(authTokens.expiresAt, now - TOKEN_RETENTION_MS), lt(authTokens.createdAt, now - HOUR)))
    .returning({ id: authTokens.id })
  const j = retention.jobDays
    ? await db
        .delete(jobs)
        .where(and(inArray(jobs.status, ['done', 'error', 'cancelled']), lt(jobs.updatedAt, now - retention.jobDays * DAY)))
        .returning({ id: jobs.id })
    : []
  const cutoff = now - INVITE_RETENTION_MS
  const i = await db
    .delete(invites)
    .where(
      and(
        lt(invites.createdAt, cutoff),
        // used or withdrawn, or past its expiry (rows from before v7 expire 7 days after creation)
        or(isNotNull(invites.acceptedAt), isNotNull(invites.revokedAt), lt(invites.expiresAt, cutoff), lt(invites.createdAt, cutoff - INVITE_TTL_MS)),
      ),
    )
    .returning({ token: invites.token })
  const a = retention.auditDays ? await db.delete(auditLog).where(lt(auditLog.at, now - retention.auditDays * DAY)).returning({ id: auditLog.id }) : []
  // tabs that stopped beating long ago (the presence sweep drops them within seconds while anyone is around)
  const p = await db.delete(presenceRows).where(lt(presenceRows.seen, now - 10 * PRESENCE_TTL_MS)).returning({ id: presenceRows.client })
  const t = await pruneTombstones()
  const out = { sessions: s.length, jobs: j.length, invites: i.length, tokens: tk.length, tombstones: t, audit: a.length, presence: p.length }
  if (Object.values(out).some(Boolean)) log.info('pruned old rows', out)
  // trashed media and exports past their retention (services/library.ts; MEDIA_TRASH_DAYS, EXPORT_RETENTION_DAYS)
  await sweepLibrary(now).catch((err) => log.warn('library retention failed', { err }))
  return out
}
