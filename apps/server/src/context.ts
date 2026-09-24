// Process-wide services (config, database, storage, event bus). Initialised once by index.ts or a test.
import type { Config } from './config'
import type { Database, DB } from './db'
import type { EventBus } from './events'
import type { Storage } from './storage'

export interface Ctx {
  config: Config
  database: Database
  db: DB
  storage: Storage
  bus: EventBus
  /** Unique id of this process (worker lock owner, NOTIFY origin). */
  instanceId: string
}

let current: Ctx | undefined

export function setCtx(c: Ctx) {
  current = c
}

export function ctx(): Ctx {
  if (!current) throw new Error('Server context not initialised')
  return current
}

export async function initCtx(config: Config): Promise<Ctx> {
  const { openDatabase } = await import('./db')
  const { createStorage } = await import('./storage')
  const { EventBus } = await import('./events')
  const { newId } = await import('./ids')
  const database = await openDatabase({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir })
  const storage = await createStorage(config)
  const instanceId = newId('w')
  const bus = new EventBus(database, instanceId)
  await bus.start()
  const c: Ctx = { config, database, db: database.db, storage, bus, instanceId }
  setCtx(c)
  return c
}
