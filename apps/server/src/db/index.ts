// Database bootstrap: Drizzle over PGlite (dev/tests, DATABASE_URL unset) or postgres-js (DATABASE_URL).
import fs from 'node:fs'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { log } from '../log'
import { DDL_V1, MIGRATIONS, SCHEMA_VERSION } from './migrate'
import { schema } from './schema'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DB = PgDatabase<any, typeof schema>

export interface Database {
  db: DB
  driver: 'pglite' | 'postgres'
  /** Run a multi-statement SQL script (no parameters). */
  exec(sqlText: string): Promise<void>
  /** Postgres LISTEN/NOTIFY (postgres-js only; no-ops on PGlite, which is single-process). */
  listen(channel: string, onPayload: (payload: string) => void): Promise<void>
  notify(channel: string, payload: string): Promise<void>
  close(): Promise<void>
}

export async function openDatabase(opts: { databaseUrl?: string; pgliteDir: string }): Promise<Database> {
  let database: Database
  if (opts.databaseUrl) {
    const postgres = (await import('postgres')).default
    const { drizzle } = await import('drizzle-orm/postgres-js')
    const client = postgres(opts.databaseUrl, { max: 10, onnotice: () => undefined, connection: { application_name: 'producer-studio' } })
    const db = drizzle(client, { schema }) as unknown as DB
    database = {
      db,
      driver: 'postgres',
      exec: async (s) => {
        await client.unsafe(s)
      },
      listen: async (channel, cb) => {
        await client.listen(channel, cb)
      },
      notify: async (channel, payload) => {
        await client.notify(channel, payload)
      },
      close: async () => {
        await client.end({ timeout: 5 })
      },
    }
    // serialise concurrent migrations from several services
    const reserved = await client.reserve()
    try {
      await reserved`SELECT pg_advisory_lock(74317)`
      await migrate(database)
    } finally {
      await reserved`SELECT pg_advisory_unlock(74317)`
      reserved.release()
    }
  } else {
    const { PGlite } = await import('@electric-sql/pglite')
    const { drizzle } = await import('drizzle-orm/pglite')
    const memory = opts.pgliteDir.startsWith('memory://')
    if (!memory) fs.mkdirSync(opts.pgliteDir, { recursive: true })
    const client = memory ? new PGlite() : new PGlite(opts.pgliteDir)
    await client.waitReady
    const db = drizzle(client, { schema }) as unknown as DB
    database = {
      db,
      driver: 'pglite',
      exec: async (s) => {
        await client.exec(s)
      },
      listen: async () => undefined,
      notify: async () => undefined,
      close: async () => {
        await client.close()
      },
    }
    await migrate(database)
  }
  log.info('database ready', { driver: database.driver })
  return database
}

async function migrate(d: Database) {
  await d.exec(DDL_V1)
  await d.exec(`INSERT INTO schema_version (id, version, updated_at) VALUES (1, 1, ${Date.now()}) ON CONFLICT (id) DO NOTHING`)
  const { sql } = await import('drizzle-orm')
  const res = (await d.db.execute(sql`SELECT version FROM schema_version WHERE id = 1`)) as unknown
  const rows = Array.isArray(res) ? res : ((res as { rows: unknown[] }).rows ?? [])
  let current = Number((rows[0] as { version?: number } | undefined)?.version ?? 1)
  for (const [v, stmt] of MIGRATIONS) {
    if (v <= current) continue
    log.info('applying migration', { version: v })
    await d.exec(stmt)
    await d.exec(`UPDATE schema_version SET version = ${v}, updated_at = ${Date.now()} WHERE id = 1`)
    current = v
  }
  if (current < SCHEMA_VERSION) await d.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION} WHERE id = 1`)
}
