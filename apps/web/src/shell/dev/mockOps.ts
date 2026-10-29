// DEV-ONLY mock routes for the operations additions (R4-A): a space's audit log (owners) and the operator tools
// (P-10), registered by mockApi.ts with its router and state. Same role rules as the server: the audit is the space
// owners', and the operator routes answer 404 unless the mock user is an operator (localStorage.psMockOperator = '1').
import type { AuditEntry, AuditKind, OperatorJob, OperatorUser, OperatorUserDetail, StorageUsageRow, User, Workspace } from '@producer/core'
import { SPACE_AUDIT_KINDS } from '@producer/core'

type Json = Record<string, unknown>
type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: Json) => Response | Promise<Response>

export interface MockOpsKit {
  on: (method: string, pattern: string, h: Handler) => void
  json: (body: unknown, status?: number) => Response
  fail: (status: number, error: string, code?: string) => Response
  currentUser: () => User | undefined
  workspaces: Workspace[]
  users: Array<User & { password: string }>
}

export const isMockOperator = () => {
  try {
    return localStorage.getItem('psMockOperator') === '1'
  } catch {
    return false
  }
}

let n = 0
const nid = (p: string) => `${p}_${Date.now().toString(36)}${++n}`

/** A page of `all` (newest first), with the mock's numeric cursor. */
function page<T>(all: T[], q: URLSearchParams) {
  const start = Number(q.get('cursor') ?? 0)
  const limit = Number(q.get('limit') ?? 50)
  return { items: all.slice(start, start + limit), ...(start + limit < all.length ? { nextCursor: String(start + limit) } : {}) }
}

export function registerOpsMocks(k: MockOpsKit) {
  const { on, json, fail, currentUser, workspaces, users } = k
  const now = Date.now()
  const log: AuditEntry[] = [
    { id: 'au_3', at: now - 2 * 3600_000, kind: 'member.role', actor: { id: 'u_demo', email: 'alex@example.com' }, workspaceId: 'ws_personal', target: 'sam@acme.test', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 Chrome/130', data: { from: 'editor', to: 'viewer' } },
    { id: 'au_2', at: now - 26 * 3600_000, kind: 'invite.created', actor: { id: 'u_demo', email: 'alex@example.com' }, workspaceId: 'ws_personal', target: 'sam@acme.test', ip: '203.0.113.7', data: { role: 'editor' } },
    { id: 'au_1', at: now - 50 * 3600_000, kind: 'signin.ok', actor: { id: 'u_demo', email: 'alex@example.com' }, ip: '203.0.113.7', data: {} },
  ]
  const record = (kind: AuditKind, e: Partial<AuditEntry> = {}) => {
    const u = currentUser()
    log.unshift({ id: nid('au'), at: Date.now(), kind, ...(u ? { actor: { id: u.id, email: u.email } } : {}), data: {}, ...e })
  }
  const disabled = new Map<string, number>()
  const jobs: OperatorJob[] = [
    { id: 'j_op1', kind: 'export.render', status: 'error', progress: 0.4, message: 'Failed', workspaceId: 'ws_team', workspaceName: 'Northwind Marketing', userId: 'u_3', attempts: 1, error: 'The export failed on the server. Try again; if it keeps failing, an operator can see the details on the job.', errorDetail: 'Render failed (exit 1): /data/renders/j_op1/out.mp4: Conversion failed! | [h264 @ 0x55d0] error', createdAt: now - 3600_000, startedAt: now - 3500_000, updatedAt: now - 3400_000, waitMs: 100_000, runMs: 100_000, peakRssBytes: 1_900_000_000, input: { projectId: 'p_team1' } },
    { id: 'j_op2', kind: 'asset.process', status: 'queued', progress: 0, message: 'Queued', workspaceId: 'ws_personal', workspaceName: "Alex's space", userId: 'u_demo', attempts: 0, createdAt: now - 60_000, updatedAt: now - 60_000, input: { assetId: 'as_rec1' } },
  ]

  const ownerOnly = (ws: string) => {
    const w = workspaces.find((x) => x.id === ws)
    if (!w) return fail(404, 'Not found', 'not_found')
    if (w.role !== 'owner') return fail(403, 'Only workspace owners can do that', 'forbidden')
    return null
  }
  const opOnly = () => (currentUser() && isMockOperator() ? null : fail(404, 'Not found', 'not_found'))

  on('GET', '/api/workspaces/([^/]+)/audit', (m, q) => {
    const denied = ownerOnly(m[1])
    if (denied) return denied
    const kind = q.get('kind')
    return json(page(log.filter((e) => e.workspaceId === m[1] && SPACE_AUDIT_KINDS.includes(e.kind) && (!kind || e.kind === kind)), q))
  })

  const opUser = (u: User): OperatorUser => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt, emailVerified: true, ...(disabled.has(u.id) ? { disabledAt: disabled.get(u.id) } : {}), spaces: 1, sessions: disabled.has(u.id) ? 0 : 1, devices: 0, lastSignInAt: now - 3600_000 })
  const detail = (u: User): OperatorUserDetail => ({ ...opUser(u), memberships: [{ workspaceId: 'ws_personal', name: `${u.name.split(' ')[0]}'s space`, role: 'owner', personal: true }], deviceList: [], recent: log.filter((e) => e.actor?.id === u.id || e.targetId === u.id).slice(0, 20) })
  const findUser = (id: string) => users.find((u) => u.id === id)

  on('GET', '/api/operator/users', (_m, q) => {
    const denied = opOnly()
    if (denied) return denied
    const s = (q.get('q') ?? '').toLowerCase()
    return json(users.filter((u) => !s || u.email.toLowerCase().includes(s) || u.name.toLowerCase().includes(s)).map(opUser))
  })
  on('GET', '/api/operator/users/([^/]+)', (m) => {
    const u = findUser(m[1])
    return opOnly() ?? (u ? json(detail(u)) : fail(404, 'No such account', 'not_found'))
  })
  on('POST', '/api/operator/users/([^/]+)/disable', (m, _q, b) => {
    const u = findUser(m[1])
    const denied = opOnly() ?? (u ? null : fail(404, 'No such account', 'not_found'))
    if (denied || !u) return denied!
    if (u.id === currentUser()?.id) return fail(409, 'You can’t disable your own account.', 'conflict')
    disabled.set(u.id, Date.now())
    record('operator.user.disabled', { targetId: u.id, target: u.email, data: b.reason ? { reason: b.reason } : {} })
    return json(detail(u))
  })
  on('POST', '/api/operator/users/([^/]+)/enable', (m) => {
    const u = findUser(m[1])
    const denied = opOnly() ?? (u ? null : fail(404, 'No such account', 'not_found'))
    if (denied || !u) return denied!
    disabled.delete(u.id)
    record('operator.user.enabled', { targetId: u.id, target: u.email })
    return json(detail(u))
  })
  on('POST', '/api/operator/users/([^/]+)/reset', (m, _q, b) => {
    const u = findUser(m[1])
    const denied = opOnly() ?? (u ? null : fail(404, 'No such account', 'not_found'))
    if (denied || !u) return denied!
    if (b.mode === 'mail') {
      record('operator.reset.mailed', { targetId: u.id, target: u.email })
      return json({ ok: true, mode: 'mail', emailed: true })
    }
    record('operator.reset.link', { targetId: u.id, target: u.email })
    return json({ ok: true, mode: 'link', url: `${location.origin}/reset/mock-${nid('t')}` })
  })

  on('GET', '/api/operator/jobs', (_m, q) => {
    const denied = opOnly()
    if (denied) return denied
    const status = q.get('status')
    const s = q.get('q') ?? ''
    return json(page(jobs.filter((j) => (!status || j.status === status) && (!s || j.id === s || (j.error ?? '').includes(s))).map(({ input: _i, ...rest }) => rest), q))
  })
  on('GET', '/api/operator/jobs/([^/]+)', (m) => {
    const j = jobs.find((x) => x.id === m[1])
    return opOnly() ?? (j ? json(j) : fail(404, 'Job not found', 'not_found'))
  })
  on('POST', '/api/operator/jobs/([^/]+)/requeue', (m) => {
    const j = jobs.find((x) => x.id === m[1])
    const denied = opOnly() ?? (j ? null : fail(404, 'Job not found', 'not_found'))
    if (denied || !j) return denied!
    if (j.status === 'queued' || j.status === 'done') return fail(409, j.status === 'queued' ? 'This job is already waiting in the queue.' : 'This job finished. Start the work again from the app instead.', 'conflict')
    Object.assign(j, { status: 'queued', attempts: 0, error: undefined, message: 'Requeued by an operator', updatedAt: Date.now() })
    record('operator.job.requeued', { targetId: j.id, target: `${j.id} (${j.kind})`, workspaceId: j.workspaceId })
    return json(j)
  })
  on('POST', '/api/operator/jobs/([^/]+)/cancel', (m) => {
    const j = jobs.find((x) => x.id === m[1])
    const denied = opOnly() ?? (j ? null : fail(404, 'Job not found', 'not_found'))
    if (denied || !j) return denied!
    if (j.status !== 'queued' && j.status !== 'running') return fail(409, 'This job has already ended.', 'conflict')
    Object.assign(j, { status: 'cancelled', error: 'Cancelled by an operator', message: 'Cancelled', updatedAt: Date.now() })
    record('operator.job.cancelled', { targetId: j.id, target: `${j.id} (${j.kind})`, workspaceId: j.workspaceId })
    return json(j)
  })

  on('GET', '/api/operator/storage', (_m, q) => {
    const denied = opOnly()
    if (denied) return denied
    const s = (q.get('q') ?? '').toLowerCase()
    const rows: StorageUsageRow[] = workspaces.map((w, i) => ({ workspaceId: w.id, name: w.name, personal: Boolean(w.personal), owner: 'alex@example.com', bytes: (3 - i) * 1_250_000_000, files: (3 - i) * 14 }))
    return json(rows.filter((r) => !s || r.name.toLowerCase().includes(s) || r.workspaceId === s))
  })
  const scans = new Set<string>()
  const orphans = [
    { key: 'ws/ws_gone/assets/as_old/source.mp4', size: 412_000_000, mtimeMs: now - 9 * 86400_000, reason: 'workspace' as const },
    { key: 'ws/ws_personal/assets/as_deleted/proxy.mp4', size: 38_000_000, mtimeMs: now - 3 * 86400_000, reason: 'asset' as const },
  ]
  on('POST', '/api/operator/storage/orphans', (_m, _q, b) => {
    const denied = opOnly()
    if (denied) return denied
    const bytes = orphans.reduce((t, o) => t + o.size, 0)
    if (!b.scanId) {
      const scanId = nid('scan')
      scans.add(scanId)
      return json({ scanId, dryRun: true, objects: orphans, count: orphans.length, bytes, scanned: 1240 })
    }
    if (!scans.delete(String(b.scanId))) return fail(410, 'That dry run expired or isn’t yours. Run it again, check the list, then remove.', 'conflict')
    const removed = orphans.length
    record('operator.storage.orphans', { target: `${removed} objects`, data: { removed, bytes } })
    orphans.splice(0)
    return json({ scanId: b.scanId, dryRun: false, objects: [], count: removed, bytes, scanned: 1240, removed })
  })
  // health and the API description (P-9, P-24): public, like the server's; metrics stay off (no METRICS_TOKEN)
  on('GET', '/api/health/live', () => json({ ok: true, role: 'all', uptimeSec: Math.round((Date.now() - now) / 1000) }))
  on('GET', '/api/health/ready', () => json({ ok: true, role: 'all', checks: { db: 'ok', migrations: { ok: true, version: 16, expected: 16 }, storage: 'ok' } }))
  on('GET', '/api/metrics', () => fail(404, 'Metrics are off on this server (METRICS_TOKEN is not set).', 'not_found'))
  on('GET', '/api/openapi.json', () => json({ openapi: '3.1.0', info: { title: 'Producer Studio API (dev mock)', version: 'mock' }, paths: {}, components: {} }))

  on('GET', '/api/operator/audit', (_m, q) => {
    const denied = opOnly()
    if (denied) return denied
    const s = (q.get('q') ?? '').toLowerCase()
    return json(page(log.filter((e) => !s || e.kind.includes(s) || (e.actor?.email ?? '').includes(s) || (e.target ?? '').toLowerCase().includes(s) || e.ip === s || e.requestId === s), q))
  })
}
