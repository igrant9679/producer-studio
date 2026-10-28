// Housekeeping: rows that can never be used again are deleted, so these tables don't grow forever.
// Runs in the worker a few minutes after start, then every 6 hours. Nothing a person can still act on is touched.
import { and, inArray, isNotNull, lt, or } from 'drizzle-orm'
import { INVITE_TTL_MS } from '@producer/core'
import { ctx } from '../context'
import { invites, jobs, sessions } from '../db/schema'
import { log } from '../log'
import { sweepLibrary } from './library'

const DAY = 24 * 3600 * 1000
/** Finished jobs are kept this long (the jobs list and job history read them). */
export const JOB_RETENTION_MS = 30 * DAY
/** Used, withdrawn and expired invites are kept this long (an invitee opening an old link still gets a clear answer). */
export const INVITE_RETENTION_MS = 30 * DAY

export async function pruneOldRows(now = Date.now()): Promise<{ sessions: number; jobs: number; invites: number }> {
  const db = ctx().db
  const s = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id })
  const j = await db
    .delete(jobs)
    .where(and(inArray(jobs.status, ['done', 'error', 'cancelled']), lt(jobs.updatedAt, now - JOB_RETENTION_MS)))
    .returning({ id: jobs.id })
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
  const out = { sessions: s.length, jobs: j.length, invites: i.length }
  if (out.sessions || out.jobs || out.invites) log.info('pruned old rows', out)
  // trashed media and exports past their retention (services/library.ts; MEDIA_TRASH_DAYS, EXPORT_RETENTION_DAYS)
  await sweepLibrary(now).catch((err) => log.warn('library retention failed', { err }))
  return out
}
