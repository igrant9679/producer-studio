// Desktop-only tables (created on desktop start, never on cloud): a key/value store and per-object sync state.
//   desktop_kv    — local user id, cloud link (URL, account, encrypted device token), pull cursor, push cursors.
//   desktop_sync  — one row per synced project/asset/brand kit:
//       projects: cloud_version (the cloud version our local copy is based on), local_version (local version at the
//                 last sync; a different local version ⇒ dirty — every local save/rename bumps it), conflict_version
//                 (cloud version that conflicts with local edits), cloud_trashed/cloud_template (flags last seen in
//                 the cloud; a local trash/template toggle that differs ⇒ dirty);
//       assets:   remote (bytes live in the cloud; fetched on demand), uploaded (exists in the cloud);
//       brand:    local_version = brand kit updated_at (ms) at the last sync.
import { sql } from 'drizzle-orm'
import { ctx } from '../context'

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
  kind: 'project' | 'asset' | 'brand'
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

export { query as rawQuery }
