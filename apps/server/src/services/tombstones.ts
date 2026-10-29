// Tombstone compaction (D-6). The change feed delivers deletes as tombstones; keeping them forever grows the table, so
// old ones may go. Deleting any tombstone raises the feed's horizon (sync_horizon, a trigger in migration v18): a
// replica whose cursor is below it may have missed deletes and is told to resync in full (SyncChanges.resync).
// The retention janitor calls compactTombstones with TOMBSTONE_RETENTION_DAYS; 0 keeps them forever.
import { sql } from 'drizzle-orm'
import { ctx } from '../context'

const DAY = 86_400_000

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  const r = (await ctx().db.execute(q)) as unknown
  return (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[]
}

/** The highest change number whose tombstone may be gone (0 when none ever was). */
export async function syncHorizon(): Promise<number> {
  const [h] = await rows<{ seq: string }>(sql`SELECT seq::text AS seq FROM sync_horizon WHERE id = 1`)
  return h ? Number(h.seq) : 0
}

/**
 * Delete tombstones older than `days`. On a desktop, never one its own push hasn't sent yet (its deletes would be
 * lost), for this account or one set aside. Returns how many went.
 */
export async function compactTombstones(days: number, now = Date.now()): Promise<number> {
  if (!(days > 0)) return 0
  const cut = now - days * DAY
  let below = Number.MAX_SAFE_INTEGER
  if (ctx().config.mode === 'desktop') {
    const { kvGet } = await import('../desktop/db')
    const parked = Object.values((await kvGet<Record<string, { tombCursor?: number }>>('parkedAccounts')) ?? {})
    below = Math.min((await kvGet<number>('tombCursor')) ?? 0, ...parked.map((p) => p.tombCursor ?? 0))
  }
  const gone = await rows<{ n: string }>(sql`
    WITH d AS (DELETE FROM tombstones WHERE deleted_at < ${cut} AND change_seq <= ${below} RETURNING 1)
    SELECT count(*)::text AS n FROM d`)
  return Number(gone[0]?.n ?? 0)
}
