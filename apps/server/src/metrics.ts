// Metrics (P-7): GET /api/metrics in Prometheus text format, guarded by METRICS_TOKEN (Authorization: Bearer …) and
// off (404) when it isn't set. Each process counts what happens in it (requests and live-update streams in an API
// process, job runs in a worker), so scrape every service; the queue's depth and lag come from the database and are
// the same from any of them.
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { Context } from 'hono'
import { and, count, eq, min, ne, sql } from 'drizzle-orm'
import type { JobKind } from '@producer/core'
import { ctx } from './context'
import { jobs } from './db/schema'
import { QUICK_KINDS } from './jobs/worker'

/** The lane a job kind runs in: quick ones (processing, voiceovers, transcription) have slots of their own. */
const isQuick = (kind: string) => QUICK_KINDS.includes(kind as JobKind)
export const laneOf = (kind: string) => (kind === 'voice.relay' ? 'relay' : isQuick(kind) ? 'quick' : 'long')

const DURATION_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800]

type Labels = Record<string, string>
const key = (l: Labels) => Object.keys(l).sort().map((k) => `${k}=${l[k]}`).join(',')

class Counter {
  readonly values = new Map<string, { labels: Labels; n: number }>()
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels)
    const v = this.values.get(k)
    if (v) v.n += by
    else this.values.set(k, { labels, n: by })
  }
}

class Histogram {
  readonly values = new Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>()
  constructor(readonly bounds: number[]) {}
  observe(labels: Labels, v: number) {
    const k = key(labels)
    let h = this.values.get(k)
    if (!h) this.values.set(k, (h = { labels, buckets: this.bounds.map(() => 0), sum: 0, count: 0 }))
    this.bounds.forEach((b, i) => v <= b && h.buckets[i]++)
    h.sum += v
    h.count++
  }
}

const m = {
  requests: new Counter(),
  signinFailures: new Counter(),
  jobRuns: new Counter(),
  jobFailures: new Counter(),
  jobDuration: new Histogram(DURATION_BUCKETS),
  jobWait: new Histogram(DURATION_BUCKETS),
}
let sseConnections = 0

export function countRequest(status: number) {
  m.requests.inc({ status: `${Math.floor(status / 100)}xx` })
}

export function countSigninFailure() {
  m.signinFailures.inc()
}

export function sseOpened() {
  sseConnections++
}

export function sseClosed() {
  sseConnections = Math.max(0, sseConnections - 1)
}

/** A job ended in this worker: how it ended, how long it ran and how long it had waited (ms). */
export function recordJobMetrics(kind: string, outcome: string, runMs: number, waitMs: number | null) {
  m.jobRuns.inc({ kind, outcome })
  if (outcome === 'error' || outcome === 'limit') m.jobFailures.inc({ kind })
  m.jobDuration.observe({ kind }, runMs / 1000)
  if (waitMs != null) m.jobWait.observe({ kind }, waitMs / 1000)
}

/** Tests: start from zero. */
export function resetMetrics() {
  for (const c of [m.requests, m.signinFailures, m.jobRuns, m.jobFailures]) c.values.clear()
  m.jobDuration.values.clear()
  m.jobWait.values.clear()
  sseConnections = 0
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
const fmtLabels = (l: Labels) => {
  const ks = Object.keys(l).sort()
  return ks.length ? `{${ks.map((k) => `${k}="${esc(l[k])}"`).join(',')}}` : ''
}

function family(out: string[], name: string, type: 'counter' | 'gauge' | 'histogram', help: string) {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
}

function counter(out: string[], name: string, help: string, c: Counter, always = false) {
  family(out, name, 'counter', help)
  if (!c.values.size && always) out.push(`${name} 0`)
  for (const v of c.values.values()) out.push(`${name}${fmtLabels(v.labels)} ${v.n}`)
}

function histogram(out: string[], name: string, help: string, h: Histogram) {
  family(out, name, 'histogram', help)
  for (const v of h.values.values()) {
    h.bounds.forEach((b, i) => out.push(`${name}_bucket${fmtLabels({ ...v.labels, le: String(b) })} ${v.buckets[i]}`))
    out.push(`${name}_bucket${fmtLabels({ ...v.labels, le: '+Inf' })} ${v.count}`)
    out.push(`${name}_sum${fmtLabels(v.labels)} ${Number(v.sum.toFixed(3))}`)
    out.push(`${name}_count${fmtLabels(v.labels)} ${v.count}`)
  }
}

/** The whole exposition: this process's counters, and the queue as the database has it now. */
export async function renderMetrics(now = Date.now()): Promise<string> {
  const out: string[] = []
  const db = ctx().db
  const queued = await db
    .select({ kind: jobs.kind, n: count(), oldest: min(jobs.createdAt) })
    .from(jobs)
    .where(and(eq(jobs.status, 'queued'), ne(jobs.kind, 'voice.relay')))
    .groupBy(jobs.kind)
  const runningRows = await db
    .select({ kind: jobs.kind, n: count() })
    .from(jobs)
    .where(sql`${jobs.status} = 'running'`)
    .groupBy(jobs.kind)
  const lanes = new Map<string, { queued: number; running: number; oldest: number | null }>()
  const lane = (l: string) => lanes.get(l) ?? (lanes.set(l, { queued: 0, running: 0, oldest: null }), lanes.get(l)!)
  for (const l of ['quick', 'long']) lane(l)
  for (const r of queued) {
    const e = lane(laneOf(r.kind))
    e.queued += Number(r.n)
    if (r.oldest != null) e.oldest = e.oldest == null ? Number(r.oldest) : Math.min(e.oldest, Number(r.oldest))
  }
  for (const r of runningRows) lane(laneOf(r.kind)).running += Number(r.n)

  family(out, 'ps_queue_depth', 'gauge', 'Jobs waiting to run, by lane.')
  for (const [l, e] of lanes) out.push(`ps_queue_depth${fmtLabels({ lane: l })} ${e.queued}`)
  family(out, 'ps_queue_lag_seconds', 'gauge', 'How long the oldest waiting job of each lane has waited (0 = none waiting).')
  for (const [l, e] of lanes) out.push(`ps_queue_lag_seconds${fmtLabels({ lane: l })} ${e.oldest == null ? 0 : Math.max(0, Math.round((now - e.oldest) / 1000))}`)
  family(out, 'ps_jobs_running', 'gauge', 'Jobs running now, by lane (every worker).')
  for (const [l, e] of lanes) out.push(`ps_jobs_running${fmtLabels({ lane: l })} ${e.running}`)
  family(out, 'ps_queue_depth_by_kind', 'gauge', 'Jobs waiting to run, by kind.')
  for (const r of queued) out.push(`ps_queue_depth_by_kind${fmtLabels({ kind: r.kind })} ${Number(r.n)}`)

  counter(out, 'ps_job_runs_total', 'Jobs this worker ended, by kind and how they ended (done, error, limit, cancelled, …).', m.jobRuns)
  counter(out, 'ps_job_failures_total', 'Jobs this worker ended with an error (or stopped at a time limit), by kind.', m.jobFailures)
  histogram(out, 'ps_job_duration_seconds', 'How long jobs ran in this worker, by kind.', m.jobDuration)
  histogram(out, 'ps_job_wait_seconds', 'How long jobs waited in the queue before this worker started them, by kind.', m.jobWait)

  family(out, 'ps_sse_connections', 'gauge', 'Live-update streams open on this process.')
  out.push(`ps_sse_connections ${sseConnections}`)
  counter(out, 'ps_signin_failures_total', 'Failed sign-ins on this process (wrong password, unknown email, disabled account).', m.signinFailures, true)
  counter(out, 'ps_http_requests_total', 'API requests this process answered, by status class.', m.requests)

  const mem = process.memoryUsage()
  family(out, 'ps_process_resident_memory_bytes', 'gauge', 'Resident memory of this process.')
  out.push(`ps_process_resident_memory_bytes ${mem.rss}`)
  family(out, 'ps_process_heap_used_bytes', 'gauge', 'JavaScript heap in use.')
  out.push(`ps_process_heap_used_bytes ${mem.heapUsed}`)
  family(out, 'ps_process_uptime_seconds', 'gauge', 'Seconds since this process started.')
  out.push(`ps_process_uptime_seconds ${Math.round(process.uptime())}`)
  return out.join('\n') + '\n'
}

function sameToken(sent: string, want: string): boolean {
  const a = crypto.createHash('sha256').update(sent).digest()
  const b = crypto.createHash('sha256').update(want).digest()
  return crypto.timingSafeEqual(a, b)
}

/** GET /api/metrics: 404 while METRICS_TOKEN is unset, 401 without the token. */
export async function metricsRoute(c: Context) {
  const token = ctx().config.metricsToken
  if (!token) return c.json({ error: 'Metrics are off on this server (METRICS_TOKEN is not set).', code: 'not_found' }, 404)
  const sent = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!sent || !sameToken(sent, token)) return c.json({ error: 'The metrics token is missing or wrong.', code: 'unauthorized' }, 401)
  c.header('Cache-Control', 'no-store')
  return c.body(await renderMetrics(), 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
}

// ---- peak memory per job ----

/** Resident bytes of a process and every process under it (Linux /proc; elsewhere the process alone). */
export function treeRss(pid = process.pid): number {
  let total = process.memoryUsage().rss
  if (process.platform !== 'linux') return total
  try {
    const page = 4096
    const parent = new Map<number, number>()
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8')
        parent.set(Number(d), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]))
      } catch {
        /* exited meanwhile */
      }
    }
    const kids = (p: number) => [...parent].filter(([, pp]) => pp === p).map(([c]) => c)
    const queue = kids(pid)
    while (queue.length) {
      const c = queue.shift()!
      try {
        total += Number(fs.readFileSync(`/proc/${c}/statm`, 'utf8').split(' ')[1]) * page
      } catch {
        /* exited meanwhile */
      }
      queue.push(...kids(c))
    }
  } catch {
    /* no /proc */
  }
  return total
}
