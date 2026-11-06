// Health checks (P-9), public and before sign-in:
//   GET /api/health        the platform's check, same shape as always (a worker process answers 503 when it's stuck)
//   GET /api/health/live   the process answers (nothing else is checked: restarting for a slow database helps no one)
//   GET /api/health/ready  it can do its work: the database answers, migrations are at SCHEMA_VERSION, storage isn't
//                          failing, and (a worker) its claim loop is alive and nothing it could run waits too long
// Railway: point the service's health check at /api/health/ready (it gates a deploy); docs/architecture.md.
import fs from 'node:fs'
import { Hono } from 'hono'
import { and, eq, inArray, min, ne, sql } from 'drizzle-orm'
import { aiConfigured } from '../ai/claude'
import { ctx } from '../context'
import { SCHEMA_VERSION } from '../db/migrate'
import { jobs } from '../db/schema'
import { log } from '../log'
import { QUICK_KINDS, claimable, workerState } from '../jobs/worker'
import { storageHealth } from '../services/storage-health'

const started = Date.now()
/** The claim loop goes round every second; this long without it means it's stuck (a hung query, a blocked loop). */
export const LOOP_QUIET_MS = 2 * 60_000

async function dbOk(): Promise<boolean> {
  try {
    await ctx().db.select({ id: jobs.id }).from(jobs).limit(1)
    return true
  } catch {
    return false
  }
}

async function schemaVersion(): Promise<number | null> {
  try {
    const r = (await ctx().db.execute(sql`SELECT version FROM schema_version WHERE id = 1`)) as unknown
    const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
    return Number((rows[0] as { version?: number } | undefined)?.version ?? 0)
  } catch {
    return null
  }
}

export interface WorkerHealth {
  ok: boolean
  /** Seconds since the claim loop last went round. */
  loopAgeSec: number
  running: number
  /** Seconds the oldest job this worker could start right now has been waiting (0 = none). */
  queueLagSec: number
  reason?: string
}

/** This process's worker (null when it runs none): stuck when its loop is quiet, or a job it has room for waits too long. */
export async function workerHealth(now = Date.now(), w = workerState()): Promise<WorkerHealth | null> {
  if (!w) return null
  const loopAge = now - w.lastLoopAt
  const room = claimable(w.running, w.concurrency, w.quick)
  let lag = 0
  if (room !== 'none') {
    const lane = room === 'quick' ? inArray(jobs.kind, [...QUICK_KINDS]) : undefined
    const [row] = await ctx()
      .db.select({ oldest: min(jobs.createdAt) })
      .from(jobs)
      .where(and(eq(jobs.status, 'queued'), ne(jobs.kind, 'voice.relay'), lane))
    if (row?.oldest != null) lag = Math.max(0, now - Number(row.oldest))
  }
  const { maxLagMs } = ctx().config.workerHealth
  const reason = loopAge > LOOP_QUIET_MS ? `The claim loop hasn't run for ${Math.round(loopAge / 1000)} s.` : lag > maxLagMs ? `A job has waited ${Math.round(lag / 60_000)} minutes while this worker has a free slot.` : undefined
  return { ok: !reason, loopAgeSec: Math.round(loopAge / 1000), running: w.running.length, queueLagSec: Math.round(lag / 1000), ...(reason ? { reason } : {}) }
}

/** What /api/health answers: the database answers, and a worker-only process (which is only its worker) isn't stuck. */
export function platformHealthy(role: string, db: boolean, worker: WorkerHealth | null): boolean {
  return db && !(role === 'worker' && worker && !worker.ok)
}

/** Free and total space on the data volume, in whole GB (nothing when it can't be told). */
async function dataDisk(): Promise<{ disk?: { freeGb: number; totalGb: number } }> {
  try {
    const s = await fs.promises.statfs(ctx().config.dataDir)
    return { disk: { freeGb: Math.floor((s.bavail * s.bsize) / 2 ** 30), totalGb: Math.round((s.blocks * s.bsize) / 2 ** 30) } }
  } catch {
    return {}
  }
}

export function healthRoutes() {
  const h = new Hono()

  // the platform's check: same shape as before P-9 (role, db, storage, features), plus the worker's state
  h.get('/', async (c) => {
    const db = (await dbOk()) ? 'ok' : 'error'
    const cfg = ctx().config
    const worker = db === 'ok' ? await workerHealth().catch(() => null) : null
    // a worker-only process is only its worker: stuck means unhealthy, so the platform can restart it
    const ok = platformHealthy(cfg.role, db === 'ok', worker)
    return c.json(
      {
        ok,
        role: cfg.role,
        db: ctx().database.driver,
        dbStatus: db,
        storage: ctx().storage.kind,
        // reported, never gating: a deploy that brings new credentials must pass this check. The reason is for
        // signed-in people only (/api/system): this endpoint is public.
        storageStatus: storageHealth().status,
        uptimeSec: Math.round((Date.now() - started) / 1000),
        // the data volume renders work on (whole GB): an export needs room for its frames, so a full disk is said here
        ...(await dataDisk()),
        features: {
          whisper: Boolean(cfg.whisperCli && cfg.whisperModel && fs.existsSync(cfg.whisperCli) && fs.existsSync(cfg.whisperModel)),
          ai: aiConfigured(),
        },
        ...(worker ? { worker } : {}),
      },
      ok ? 200 : 503,
    )
  })

  h.get('/live', (c) => c.json({ ok: true, role: ctx().config.role, uptimeSec: Math.round((Date.now() - started) / 1000) }))

  h.get('/ready', async (c) => {
    const db = await dbOk()
    const version = db ? await schemaVersion() : null
    // a newer deploy may already have migrated further while this one still runs: that is fine
    const migrations = version != null && version >= SCHEMA_VERSION
    const storage = storageHealth().status !== 'error'
    const worker = db ? await workerHealth().catch(() => null) : null
    const ok = db && migrations && storage && (!worker || worker.ok)
    return c.json(
      {
        ok,
        role: ctx().config.role,
        checks: {
          db: db ? 'ok' : 'error',
          migrations: { ok: migrations, version, expected: SCHEMA_VERSION },
          storage: storageHealth().status,
          ...(worker ? { worker } : {}),
        },
      },
      ok ? 200 : 503,
    )
  })

  return h
}

/**
 * With WORKER_STUCK_EXIT_MINUTES, a worker that stays unhealthy that long exits (code 1) so the platform restarts it;
 * its jobs go back in the queue through stale recovery on the other workers (or on its own restart).
 */
export function startWorkerWatchdog(): () => void {
  const { stuckExitMs } = ctx().config.workerHealth
  if (!stuckExitMs) return () => undefined
  let badSince = 0
  const t = setInterval(() => {
    void workerHealth()
      .then((h) => {
        if (!h || h.ok) return void (badSince = 0)
        badSince ||= Date.now()
        if (Date.now() - badSince < stuckExitMs) return
        log.error('worker stuck: exiting so the platform restarts it', { reason: h.reason, loopAgeSec: h.loopAgeSec, queueLagSec: h.queueLagSec })
        process.exit(1)
      })
      .catch((err) => log.warn('worker health check failed', { err }))
  }, 30_000)
  t.unref()
  return () => clearInterval(t)
}
