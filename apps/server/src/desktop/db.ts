// Desktop-only tables (created on desktop start, never on cloud): a key/value store and per-object sync state.
//   desktop_kv    — local user id, cloud link (URL, account, encrypted device token), pull cursor, push cursors.
//   desktop_sync  — one row per synced project/asset/brand kit:
//       projects: cloud_version (the cloud version our local copy is based on), local_version (local version at the
//                 last sync; a different local version ⇒ dirty — every local save/rename bumps it), conflict_version
//                 (cloud version that conflicts with local edits), cloud_trashed/cloud_template (flags last seen in
//                 the cloud; a local trash/template toggle that differs ⇒ dirty);
//       assets:   remote (bytes live in the cloud; fetched on demand), uploaded (exists in the cloud);
//       brand:    local_version = brand kit updated_at (ms) at the last sync.
//   desktop_sync_failures — items whose push keeps failing (the rest of the cycle carries on): the reason, attempts,
//                 when to try again, and whether the person chose Skip (stays on this computer until Retry).
import { sql } from 'drizzle-orm'
import type { BrandKitDoc, SyncFailure, SyncNotice } from '@producer/core'
import { ctx } from '../context'
import { newId } from '../ids'

export const DESKTOP_DDL = `
CREATE TABLE IF NOT EXISTS desktop_kv (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS desktop_sync (
  kind text NOT NULL,
  id text NOT NULL,
  cloud_version integer,
  local_version double precision,
  conflict_version integer,
  remote boolean NOT NULL DEFAULT false,
  uploaded boolean NOT NULL DEFAULT false,
  cloud_trashed boolean,
  cloud_template boolean,
  updated_at double precision NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS desktop_sync_failures (
  kind text NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  error text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  next_at double precision,
  skipped boolean NOT NULL DEFAULT false,
  first_at double precision NOT NULL,
  updated_at double precision NOT NULL,
  PRIMARY KEY (kind, id)
);
`

export async function ensureDesktopTables() {
  await ctx().database.exec(DESKTOP_DDL)
}

type Rows<T> = T[]
async function query<T>(q: ReturnType<typeof sql>): Promise<Rows<T>> {
  const res = (await ctx().db.execute(q)) as unknown
  return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as T[]
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const rows = await query<{ value: T }>(sql`SELECT value FROM desktop_kv WHERE key = ${key}`)
  return rows[0]?.value
}

export async function kvSet(key: string, value: unknown) {
  await ctx().db.execute(sql`INSERT INTO desktop_kv (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
}

export async function kvDelete(key: string) {
  await ctx().db.execute(sql`DELETE FROM desktop_kv WHERE key = ${key}`)
}

export interface SyncRow {
  kind: 'project' | 'asset' | 'brand' | 'voice'
  id: string
  cloudVersion: number | null
  localVersion: number | null
  conflictVersion: number | null
  remote: boolean
  uploaded: boolean
  cloudTrashed: boolean | null
  cloudTemplate: boolean | null
}

interface RawSyncRow {
  kind: SyncRow['kind']
  id: string
  cloud_version: number | null
  local_version: string | number | null
  conflict_version: number | null
  remote: boolean
  uploaded: boolean
  cloud_trashed: boolean | null
  cloud_template: boolean | null
}

const toRow = (r: RawSyncRow): SyncRow => ({
  kind: r.kind,
  id: r.id,
  cloudVersion: r.cloud_version,
  localVersion: r.local_version == null ? null : Number(r.local_version),
  conflictVersion: r.conflict_version,
  remote: r.remote,
  uploaded: r.uploaded,
  cloudTrashed: r.cloud_trashed,
  cloudTemplate: r.cloud_template,
})

export async function syncRows(kind: SyncRow['kind']): Promise<Map<string, SyncRow>> {
  const rows = await query<RawSyncRow>(sql`SELECT * FROM desktop_sync WHERE kind = ${kind}`)
  return new Map(rows.map((r) => [r.id, toRow(r)]))
}

export async function syncRow(kind: SyncRow['kind'], id: string): Promise<SyncRow | undefined> {
  const rows = await query<RawSyncRow>(sql`SELECT * FROM desktop_sync WHERE kind = ${kind} AND id = ${id}`)
  return rows[0] ? toRow(rows[0]) : undefined
}

/** Insert or merge fields of a sync row. */
export async function putSync(kind: SyncRow['kind'], id: string, patch: Partial<Omit<SyncRow, 'kind' | 'id'>>) {
  const cur = await syncRow(kind, id)
  const next: SyncRow = { kind, id, cloudVersion: null, localVersion: null, conflictVersion: null, remote: false, uploaded: false, cloudTrashed: null, cloudTemplate: null, ...cur, ...patch }
  await ctx().db.execute(sql`
    INSERT INTO desktop_sync (kind, id, cloud_version, local_version, conflict_version, remote, uploaded, cloud_trashed, cloud_template, updated_at)
    VALUES (${kind}, ${id}, ${next.cloudVersion}, ${next.localVersion}, ${next.conflictVersion}, ${next.remote}, ${next.uploaded}, ${next.cloudTrashed}, ${next.cloudTemplate}, ${Date.now()})
    ON CONFLICT (kind, id) DO UPDATE SET cloud_version = EXCLUDED.cloud_version, local_version = EXCLUDED.local_version, conflict_version = EXCLUDED.conflict_version,
      remote = EXCLUDED.remote, uploaded = EXCLUDED.uploaded, cloud_trashed = EXCLUDED.cloud_trashed, cloud_template = EXCLUDED.cloud_template, updated_at = EXCLUDED.updated_at`)
}

export async function deleteSync(kind: SyncRow['kind'], id: string) {
  await ctx().db.execute(sql`DELETE FROM desktop_sync WHERE kind = ${kind} AND id = ${id}`)
}

export async function clearSync() {
  await ctx().db.execute(sql`DELETE FROM desktop_sync`)
}

// ---------------- items that keep failing ----------------

export type FailureKind = SyncFailure['kind']

interface RawFailure {
  kind: FailureKind
  id: string
  name: string
  error: string
  attempts: number
  next_at: string | number | null
  skipped: boolean
  updated_at: string | number
}

const toFailure = (r: RawFailure): SyncFailure => ({
  kind: r.kind,
  id: r.id,
  name: r.name,
  error: r.error,
  attempts: Number(r.attempts),
  skipped: r.skipped,
  at: Number(r.updated_at),
  ...(r.next_at != null && !r.skipped ? { nextAt: Number(r.next_at) } : {}),
})

export const failureKey = (kind: string, id: string) => `${kind}:${id}`

export async function failureMap(): Promise<Map<string, SyncFailure>> {
  const rows = await query<RawFailure>(sql`SELECT * FROM desktop_sync_failures ORDER BY first_at`)
  return new Map(rows.map((r) => [failureKey(r.kind, r.id), toFailure(r)]))
}

export async function listFailures(): Promise<SyncFailure[]> {
  return [...(await failureMap()).values()]
}

/** Retry after 1, 2, 4 … minutes, at most hourly. */
export const failureBackoffMs = (attempts: number) => Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1))

export async function recordFailure(kind: FailureKind, id: string, name: string, error: string): Promise<SyncFailure> {
  const now = Date.now()
  const rows = await query<RawFailure>(sql`
    INSERT INTO desktop_sync_failures (kind, id, name, error, attempts, next_at, skipped, first_at, updated_at)
    VALUES (${kind}, ${id}, ${name.slice(0, 200)}, ${error.slice(0, 500)}, 1, ${now + failureBackoffMs(1)}, false, ${now}, ${now})
    ON CONFLICT (kind, id) DO UPDATE SET name = EXCLUDED.name, error = EXCLUDED.error, attempts = desktop_sync_failures.attempts + 1,
      next_at = ${now}::double precision + LEAST(3600000, 60000 * power(2, desktop_sync_failures.attempts)), updated_at = EXCLUDED.updated_at
    RETURNING *`)
  return toFailure(rows[0])
}

export async function clearFailure(kind: FailureKind, id: string) {
  await ctx().db.execute(sql`DELETE FROM desktop_sync_failures WHERE kind = ${kind} AND id = ${id}`)
}

/** Retry (due now, not skipped) or Skip. False when there is no such failure. */
export async function setFailure(kind: FailureKind, id: string, patch: { skipped: boolean }): Promise<boolean> {
  const rows = await query<{ id: string }>(sql`
    UPDATE desktop_sync_failures SET skipped = ${patch.skipped}, next_at = ${patch.skipped ? null : 0}
    WHERE kind = ${kind} AND id = ${id} RETURNING id`)
  return rows.length > 0
}

// ---------------- notices ----------------
// What sync did to keep someone's work safe, kept (newest 50) until dismissed. `data` is what the notice's action needs
// (a brand kit set aside at link time); it stays here and never goes to the UI.

export interface StoredNotice extends SyncNotice {
  data?: { kind: 'brand'; workspaceId: string; doc: BrandKitDoc }
}

export async function listNotices(): Promise<StoredNotice[]> {
  return (await kvGet<StoredNotice[]>('notices')) ?? []
}

export async function addNotice(message: string, extra: Pick<StoredNotice, 'action' | 'data'> = {}): Promise<StoredNotice> {
  const n: StoredNotice = { id: newId('n'), message, at: Date.now(), ...extra }
  await kvSet('notices', [...(await listNotices()), n].slice(-50))
  return n
}

export async function removeNotice(id: string): Promise<StoredNotice | undefined> {
  const all = await listNotices()
  const hit = all.find((n) => n.id === id)
  if (hit) await kvSet('notices', all.filter((n) => n.id !== id))
  return hit
}

export { query as rawQuery }
