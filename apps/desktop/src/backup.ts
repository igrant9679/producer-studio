// A copy of the local database before the engine updates it (D-10). Migrations run when a newer app starts its
// engine for the first time, so the PGlite folder (<data>/pg) is copied to <data>/backups/db-<time>-<label>/pg just
// before that start, while nothing has it open; the newest few are kept. Media and renders aren't copied (they aren't
// changed by a migration, and are often GBs). docs/desktop.md says how to restore one. No Electron here.
import fs from 'node:fs'
import path from 'node:path'

export const DB_BACKUPS_KEPT = 3

export interface StartInfo {
  version: string
  /** The database schema this build migrates to (from build-info.json); unknown in dev. */
  schema?: number
}

export interface Backup {
  name: string
  dir: string
  at: number
  bytes: number
}

export const dbDir = (dataDir: string) => path.join(dataDir, 'pg')
export const backupsDir = (dataDir: string) => path.join(dataDir, 'backups')

/**
 * Whether this start may migrate the database: a newer schema than the last start's, or (schema unknown) another app
 * version. A database from before this was recorded counts as "may migrate". No database yet: nothing to keep.
 */
export function needsBackup(last: StartInfo | undefined, now: StartInfo, dbExists: boolean): boolean {
  if (!dbExists) return false
  if (!last) return true
  if (last.schema !== undefined && now.schema !== undefined) return now.schema > last.schema
  return last.version !== now.version
}

function sizeOf(dir: string): number {
  let n = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    n += e.isDirectory() ? sizeOf(p) : e.isFile() ? fs.statSync(p).size : 0
  }
  return n
}

/** The backups in this data folder, newest first. */
export function listBackups(dataDir: string): Backup[] {
  const root = backupsDir(dataDir)
  let names: string[] = []
  try {
    names = fs.readdirSync(root).filter((n) => /^db-\d{8}T\d{6}Z/.test(n) && fs.statSync(path.join(root, n)).isDirectory())
  } catch {
    return []
  }
  return names
    .sort()
    .reverse()
    .map((name) => {
      const m = name.match(/^db-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/)!
      const dir = path.join(root, name)
      return { name, dir, at: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), bytes: sizeOf(dir) }
    })
}

const stamp = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')

/**
 * Copy the database folder into a new backup and keep only the newest `keep`. Returns the backup, or null when there
 * is no database yet. A copy that fails half way is removed and the error thrown (the database itself is untouched).
 */
export function backupDatabase(dataDir: string, o: { label: string; keep?: number; now?: number }): Backup | null {
  const src = dbDir(dataDir)
  if (!fs.existsSync(src)) return null
  const label = o.label.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const name = `db-${stamp(o.now ?? Date.now())}-${label}`
  const dir = path.join(backupsDir(dataDir), name)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.cpSync(src, path.join(dir, 'pg'), { recursive: true, errorOnExist: true, force: false })
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
  for (const old of listBackups(dataDir).slice(Math.max(1, o.keep ?? DB_BACKUPS_KEPT))) fs.rmSync(old.dir, { recursive: true, force: true })
  return listBackups(dataDir).find((b) => b.name === name) ?? null
}
