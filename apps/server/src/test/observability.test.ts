// Operations (R4-A): request ids in headers, logs and error bodies, the metrics endpoint, what each job waited, ran and
// used (P-7); liveness, readiness and worker health (P-9).
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ctx } from '../context'
import { SCHEMA_VERSION } from '../db/migrate'
import { jobs } from '../db/schema'
import { enqueue, getJob } from '../jobs/queue'
import { registerHandler, startWorker, stopWorker } from '../jobs/worker'
import { captureLogs } from '../log'
import { resetMetrics } from '../metrics'
import { platformHealthy, workerHealth } from '../routes/health'
import { type Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
let A: { client: Client; workspaceId: string; email: string }
beforeAll(async () => {
  t = await setup()
  A = await signup(t.app, 'Ops Person')
})
afterEach(() => {
  captureLogs(undefined)
  ctx().config.metricsToken = undefined
  vi.restoreAllMocks()
})

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('request ids (P-7)', () => {
  it('every answer names its request; a sane id sent in is kept, anything else replaced', async () => {
    const r = await A.client.req('GET', '/api/auth/me')
    const id = r.headers.get('x-request-id')
    expect(id).toMatch(/^[\w-]{8,}$/)
    const mine = await A.client.req('GET', '/api/auth/me', undefined, { 'x-request-id': 'edge-1234abcd' })
    expect(mine.headers.get('x-request-id')).toBe('edge-1234abcd')
    const bad = await A.client.req('GET', '/api/auth/me', undefined, { 'x-request-id': 'no spaces <script>' })
    expect(bad.headers.get('x-request-id')).not.toContain('script')
  })

  it('error bodies carry it, and a 500 tells the person the reference to quote', async () => {
    const nf = await A.client.req('GET', '/api/projects/nope')
    expect((await nf.json()).requestId).toBe(nf.headers.get('x-request-id'))
    const lines: Array<Record<string, unknown>> = []
    captureLogs((rec) => lines.push(rec))
    // the next database read fails with something unexpected (and a server path in it)
    vi.spyOn(ctx().db, 'select').mockImplementationOnce(() => {
      throw new Error('boom at /srv/app/secret/thing.ts')
    })
    const res = await A.client.req('GET', '/api/account', undefined, { 'x-request-id': 'quote-me-123' })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'server', requestId: 'quote-me-123' })
    expect(body.error).toBe('Something went wrong on our side. If it keeps happening, quote reference quote-me-123.')
    expect(body.error).not.toContain('/srv')
    // the operator finds the log line by that reference
    const line = lines.find((l) => l.msg === 'unhandled error')
    expect(line).toMatchObject({ reqId: 'quote-me-123', level: 'error' })
    expect(lines.find((l) => l.msg === 'http' && l.reqId === 'quote-me-123')).toMatchObject({ status: 500 })
  })
})

describe('metrics (P-7)', () => {
  it('are off without METRICS_TOKEN, and need the token when it is set', async () => {
    expect((await t.app.request('/api/metrics')).status).toBe(404)
    ctx().config.metricsToken = 'metrics-secret-token-123456'
    expect((await t.app.request('/api/metrics')).status).toBe(401)
    expect((await t.app.request('/api/metrics', { headers: { authorization: 'Bearer wrong-token-wrong-token-1' } })).status).toBe(401)
    const ok = await t.app.request('/api/metrics', { headers: { authorization: 'Bearer metrics-secret-token-123456' } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toContain('text/plain')
  })

  it('show queue depth and lag per lane, failed sign-ins, live streams and job runs', async () => {
    resetMetrics()
    ctx().config.metricsToken = 'metrics-secret-token-123456'
    const scrape = async () => (await t.app.request('/api/metrics', { headers: { authorization: 'Bearer metrics-secret-token-123456' } })).text()
    const value = (text: string, series: string) => Number(text.split('\n').find((l) => l.startsWith(`${series} `))?.split(' ')[1] ?? NaN)
    const me = (await A.client.json('GET', '/api/auth/me')).body.user.id
    // a long-lane job waiting for two minutes (inserted, so no worker takes it)
    const old = Date.now() - 120_000
    await ctx().db.insert(jobs).values({ id: `j_lag_${Date.now()}`, kind: 'export.render', status: 'queued', input: {}, workspaceId: A.workspaceId, userId: me, createdAt: old, updatedAt: old })
    const before = await scrape()
    expect(value(before, 'ps_queue_depth{lane="long"}')).toBeGreaterThanOrEqual(1)
    expect(value(before, 'ps_queue_lag_seconds{lane="long"}')).toBeGreaterThanOrEqual(119)
    expect(before).toContain('ps_queue_depth{lane="quick"}')
    expect(value(before, 'ps_signin_failures_total')).toBe(0)

    await new (await import('./helpers')).Client(t.app).json('POST', '/api/auth/login', { email: A.email, password: 'wrong password!' })
    expect(value(await scrape(), 'ps_signin_failures_total')).toBe(1)

    const ac = new AbortController()
    const stream = await A.client.req('GET', `/api/events?workspaceId=${A.workspaceId}`, undefined, {})
    const reader = stream.body!.getReader()
    await reader.read()
    expect(value(await scrape(), 'ps_sse_connections')).toBe(1)
    await reader.cancel()
    ac.abort()
    await waitFor(async () => value(await scrape(), 'ps_sse_connections') === 0)
    await ctx().db.update(jobs).set({ status: 'cancelled' }).where(eq(jobs.createdAt, old))
  })
})

describe('what each job waited, ran and used (P-7)', () => {
  afterAll(async () => {
    await stopWorker()
  })

  it('is recorded on the job, and in the worker metrics', async () => {
    resetMetrics()
    const me = (await A.client.json('GET', '/api/auth/me')).body.user.id
    registerHandler('media.scenes', async (jc) => {
      jc.progress(0.5)
      await new Promise((r) => setTimeout(r, 120))
      return { ok: true }
    })
    const j = await enqueue('media.scenes', {}, { workspaceId: A.workspaceId, userId: me })
    startWorker({ concurrency: 1, quickConcurrency: 1, heartbeatMs: 50 })
    const done = await waitFor(async () => ((row) => (row?.runMs != null ? row : undefined))(await getJob(j.id)))
    expect(done.status).toBe('done')
    expect(done.runMs).toBeGreaterThanOrEqual(100)
    expect(done.waitMs).toBeGreaterThanOrEqual(0)
    expect(done.peakRss).toBeGreaterThan(10 * 1024 * 1024)
    ctx().config.metricsToken = 'metrics-secret-token-123456'
    const text = await (await t.app.request('/api/metrics', { headers: { authorization: 'Bearer metrics-secret-token-123456' } })).text()
    expect(text).toContain('ps_job_runs_total{kind="media.scenes",outcome="done"} 1')
    expect(text).toMatch(/ps_job_duration_seconds_count\{kind="media.scenes"\} 1/)
    expect(text).toMatch(/ps_job_wait_seconds_count\{kind="media.scenes"\} 1/)
  })
})

describe('health (P-9)', () => {
  it('/api/health keeps its shape; /live answers; /ready checks the database, migrations and storage', async () => {
    const h = await (await t.app.request('/api/health')).json()
    expect(h).toMatchObject({ ok: true, dbStatus: 'ok', storage: 'local' })
    expect(h).toHaveProperty('features')
    const live = await t.app.request('/api/health/live')
    expect(live.status).toBe(200)
    expect(await live.json()).toMatchObject({ ok: true })
    const ready = await t.app.request('/api/health/ready')
    expect(ready.status).toBe(200)
    expect(await ready.json()).toMatchObject({ ok: true, checks: { db: 'ok', migrations: { ok: true, version: SCHEMA_VERSION, expected: SCHEMA_VERSION } } })
  })

  it('a bearer token on a health check is not read as a device token', async () => {
    const r = await t.app.request('/api/health/ready', { headers: { authorization: 'Bearer some-platform-token-1234567890' } })
    expect(r.status).toBe(200)
  })

  it('readiness fails while migrations are behind', async () => {
    await ctx().database.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`)
    try {
      const r = await t.app.request('/api/health/ready')
      expect(r.status).toBe(503)
      expect((await r.json()).checks.migrations).toMatchObject({ ok: false, version: SCHEMA_VERSION - 1 })
    } finally {
      await ctx().database.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION} WHERE id = 1`)
    }
  })

  it('a quiet claim loop, or a job waiting too long while the worker has a free slot, reports unhealthy', async () => {
    await stopWorker()
    expect(await workerHealth()).toBeNull()
    // a running worker with nothing to do is healthy; one whose loop stopped going round is not
    startWorker({ concurrency: 1, quickConcurrency: 0, heartbeatMs: 1000 })
    try {
      await waitFor(async () => (await workerHealth())?.ok)
      const quiet = await workerHealth(Date.now() + 5 * 60_000)
      expect(quiet).toMatchObject({ ok: false })
      expect(quiet!.reason).toMatch(/claim loop hasn't run/)
    } finally {
      await stopWorker()
    }
    // the lag is judged against what the worker has room for (a state given here, so no worker takes the job)
    const me = (await A.client.json('GET', '/api/auth/me')).body.user.id
    const old = Date.now() - 30 * 60_000
    const id = `j_stuck_${Date.now()}`
    await ctx().db.insert(jobs).values({ id, kind: 'export.render', status: 'queued', input: {}, workspaceId: A.workspaceId, userId: me, createdAt: old, updatedAt: old })
    try {
      const now = Date.now()
      const free = await workerHealth(now, { lastLoopAt: now, running: [], concurrency: 1, quick: 0 })
      expect(free).toMatchObject({ ok: false })
      expect(free!.queueLagSec).toBeGreaterThanOrEqual(30 * 60)
      expect(free!.reason).toMatch(/waited \d+ minutes while this worker has a free slot/)
      // every slot busy: waiting is the queue doing its job, not a stuck worker
      const busy = await workerHealth(now, { lastLoopAt: now, running: [{ kind: 'export.render' }], concurrency: 1, quick: 0 })
      expect(busy).toMatchObject({ ok: true, queueLagSec: 0 })
    } finally {
      await ctx().db.update(jobs).set({ status: 'cancelled' }).where(eq(jobs.id, id))
    }
  })

  it('a worker-only process is unhealthy on /api/health while its worker is stuck; an API process only shows it', async () => {
    const stuck = { ok: false, loopAgeSec: 300, running: 0, queueLagSec: 0, reason: 'x' }
    const fine = { ...stuck, ok: true }
    expect(platformHealthy('worker', true, stuck)).toBe(false)
    expect(platformHealthy('worker', true, fine)).toBe(true)
    expect(platformHealthy('all', true, stuck)).toBe(true)
    expect(platformHealthy('api', false, null)).toBe(false)
    // and the worker's state is in the answer
    startWorker({ concurrency: 1, quickConcurrency: 0, heartbeatMs: 1000 })
    try {
      // (on a shared database it may already have claimed someone else's queued job)
      expect((await (await t.app.request('/api/health')).json()).worker).toMatchObject({ ok: true, running: expect.any(Number), loopAgeSec: expect.any(Number) })
    } finally {
      await stopWorker()
    }
  })
})
