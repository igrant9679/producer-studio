// Operations (R4-A): the security audit log (P-8), the operator tools (P-10), and the sign-in limiter counted in
// Postgres (carried). The limiter and the audit queries are SQL: run this file with TEST_DATABASE_URL too.
import fs from 'node:fs'
import { and, eq, like } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AuditEntry } from '@producer/core'
import { auditSentence } from '@producer/core'
import { ctx } from '../context'
import { auditLog, jobs, rateWindows } from '../db/schema'
import { enqueue, getJob } from '../jobs/queue'
import { Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})
afterEach(() => {
  ctx().config.operatorEmails = []
})

const me = async (c: Client) => (await c.json('GET', '/api/auth/me')).body.user.id as string
const entries = async (where: { kind?: string; targetId?: string; actorId?: string }) =>
  ctx()
    .db.select()
    .from(auditLog)
    .where(and(where.kind ? eq(auditLog.kind, where.kind) : undefined, where.targetId ? eq(auditLog.targetId, where.targetId) : undefined, where.actorId ? eq(auditLog.actorId, where.actorId) : undefined))

async function operator() {
  const O = await signup(t.app, 'Olive Operator')
  ctx().config.operatorEmails = [O.email]
  return { ...O, id: await me(O.client) }
}

describe('sign-in limiter in Postgres (carried)', () => {
  it('counts failures in rate_windows, refuses past the limit even with the right password, and a right password clears the pair', async () => {
    const A = await signup(t.app, 'Limited')
    const login = (password: string) => new Client(t.app).req('POST', '/api/auth/login', JSON.stringify({ email: A.email, password }), { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.50' })
    for (let i = 0; i < 5; i++) expect((await login('wrong-password')).status).toBe(401)
    const rows = await ctx().db.select().from(rateWindows).where(like(rateWindows.key, `login:%${A.email}%`))
    expect(rows.find((r) => r.key.startsWith('login:pair:'))?.n).toBe(5)
    // the right password clears this person's own count, so their next mistakes start again from zero
    expect((await login('correct-horse-1')).status).toBe(200)
    expect((await ctx().db.select().from(rateWindows).where(like(rateWindows.key, 'login:pair:%')).then((r) => r.filter((x) => x.key.includes(A.email)))).length).toBe(0)
    for (let i = 0; i < 8; i++) expect((await login('wrong-password')).status).toBe(401)
    const blocked = await login('correct-horse-1')
    expect(blocked.status).toBe(429)
    expect((await blocked.json()).error).toMatch(/^Too many sign-in attempts\. Try again in \d+ minutes\.$/)
  })
})

describe('the audit log (P-8)', () => {
  it('records sign-ins, failed ones, password changes and app links with who, when, address, browser and request', async () => {
    const A = await signup(t.app, 'Audited')
    const id = await me(A.client)
    const ua = { 'content-type': 'application/json', 'user-agent': 'AuditTest/1.0', 'x-request-id': 'audit-req-001' }
    await new Client(t.app).req('POST', '/api/auth/login', JSON.stringify({ email: A.email, password: 'nope-nope' }), ua)
    const B = new Client(t.app)
    expect((await B.req('POST', '/api/auth/login', JSON.stringify({ email: A.email, password: 'correct-horse-1' }), ua)).status).toBe(200)
    const [failed] = await entries({ kind: 'signin.failed', targetId: id })
    expect(failed).toMatchObject({ actorId: null, target: A.email, userAgent: 'AuditTest/1.0', requestId: 'audit-req-001', data: { reason: 'password' } })
    expect(failed.ip).toBeTruthy()
    const [ok] = await entries({ kind: 'signin.ok', actorId: id })
    expect(ok).toMatchObject({ actorEmail: A.email, userAgent: 'AuditTest/1.0' })
    // an unknown address is recorded too, without a target id
    await new Client(t.app).json('POST', '/api/auth/login', { email: 'nobody-here@example.com', password: 'x' })
    expect((await ctx().db.select().from(auditLog).where(and(eq(auditLog.kind, 'signin.failed'), eq(auditLog.target, 'nobody-here@example.com'))))[0].data).toMatchObject({ reason: 'unknown' })

    expect((await A.client.json('POST', '/api/account/password', { current: 'correct-horse-1', password: 'correct-horse-2' })).status).toBe(200)
    expect(await entries({ kind: 'password.changed', actorId: id })).toHaveLength(1)
    const dev = (await A.client.json('POST', '/api/devices', { name: 'Studio PC' })).body
    expect((await A.client.json('DELETE', `/api/devices/${dev.deviceId}`)).status).toBe(200)
    expect((await entries({ kind: 'device.created', targetId: dev.deviceId }))[0]).toMatchObject({ actorId: id, target: 'Studio PC' })
    expect(await entries({ kind: 'device.revoked', targetId: dev.deviceId })).toHaveLength(1)
    expect((await A.client.json('POST', '/api/account/sign-out-everywhere')).status).toBe(200)
    expect(await entries({ kind: 'sessions.ended', actorId: id })).toHaveLength(1)
  })

  it('records invites, roles, hand-overs, removals, AI keys and deletes; owners read their space’s Audit, nobody else', async () => {
    const A = await signup(t.app, 'Space Owner')
    const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Audited team' })).body.id as string
    const E = await signup(t.app, 'Eddie Editor')
    const eId = await me(E.client)
    const inv = (await A.client.json('POST', `/api/workspaces/${ws}/invites`, { email: E.email, role: 'editor' })).body
    const token = inv.inviteUrl.split('/invite/')[1]
    expect((await E.client.json('POST', `/api/invites/${token}/accept`)).status).toBe(200)
    const V = await signup(t.app, 'Vera')
    const inv2 = (await A.client.json('POST', `/api/workspaces/${ws}/invites`, { email: V.email, role: 'viewer' })).body
    expect((await A.client.json('DELETE', `/api/workspaces/${ws}/invites/${inv2.inviteUrl.split('/invite/')[1]}`)).status).toBe(200)
    expect((await A.client.json('PATCH', `/api/workspaces/${ws}/members/${eId}`, { role: 'viewer' })).status).toBe(200)
    expect((await A.client.json('PATCH', `/api/workspaces/${ws}/members/${eId}`, { role: 'editor' })).status).toBe(200)
    expect((await A.client.json('PUT', '/api/usage/builtin-ai', { workspaceId: ws, enabled: false })).status).toBe(200)
    expect((await A.client.json('DELETE', `/api/ai/keys/openai?workspaceId=${ws}`)).status).toBe(200)
    expect((await A.client.json('POST', `/api/workspaces/${ws}/members/${eId}/transfer`)).status).toBe(200)

    // the new owner reads the space's audit, newest first; the old owner (now an editor) can't
    const page = await E.client.json('GET', `/api/workspaces/${ws}/audit`)
    expect(page.status).toBe(200)
    const items = page.body.items as AuditEntry[]
    expect(items.map((e) => e.kind)).toEqual(['member.transfer', 'ai.key.removed', 'ai.builtin', 'member.role', 'member.role', 'invite.withdrawn', 'invite.created', 'invite.accepted', 'invite.created'])
    expect(auditSentence(items.find((e) => e.kind === 'member.role')!)).toBe(`${A.email} changed ${E.email}’s role from viewer to editor`)
    expect(auditSentence(items[0])).toBe(`${A.email} handed the space over to ${E.email}`)
    expect(items.find((e) => e.kind === 'invite.accepted')).toMatchObject({ actor: { id: eId, email: E.email }, data: { role: 'editor' } })
    expect((await A.client.json('GET', `/api/workspaces/${ws}/audit`)).status).toBe(403)
    expect((await V.client.json('GET', `/api/workspaces/${ws}/audit`)).status).toBe(404)
    // account events aren't a space's: sign-ins don't show there
    expect(items.some((e) => e.kind.startsWith('signin'))).toBe(false)
    // one kind at a time, and paged
    expect((await E.client.json('GET', `/api/workspaces/${ws}/audit?kind=member.role`)).body.items).toHaveLength(2)
    const first = await E.client.json('GET', `/api/workspaces/${ws}/audit?limit=4`)
    const next = await E.client.json('GET', `/api/workspaces/${ws}/audit?limit=4&cursor=${first.body.nextCursor}`)
    expect([...first.body.items, ...next.body.items].map((e: AuditEntry) => e.id)).toEqual(items.slice(0, 8).map((e) => e.id))

    expect((await E.client.json('DELETE', `/api/workspaces/${ws}`)).status).toBe(200)
    expect((await entries({ kind: 'workspace.deleted', targetId: ws }))[0]).toMatchObject({ actorId: eId, workspaceId: ws, data: { name: 'Audited team' } })
  })
})

describe('the operator (P-10)', () => {
  it('is nobody unless OPERATOR_EMAILS names them; to everyone else the routes do not exist', async () => {
    const A = await signup(t.app, 'Not An Operator')
    expect((await A.client.json('GET', '/api/operator/users')).status).toBe(404)
    expect((await A.client.json('GET', '/api/auth/me')).body.operator).toBeUndefined()
    const O = await operator()
    expect((await O.client.json('GET', '/api/auth/me')).body.operator).toBe(true)
    expect((await O.client.json('GET', '/api/operator/users')).status).toBe(200)
    expect((await A.client.json('GET', '/api/operator/users')).status).toBe(404)
    // a device token never reaches them, even an operator's
    const dev = (await O.client.json('POST', '/api/devices', { name: 'Op laptop' })).body
    expect((await t.app.request('/api/operator/users', { headers: { authorization: `Bearer ${dev.token}` } })).status).toBe(403)
  })

  it('finds a person, disables them (signed out everywhere, apps unlinked, sign-in refused) and enables them again', async () => {
    const O = await operator()
    const P = await signup(t.app, 'Pat Problem')
    const pId = await me(P.client)
    const dev = (await P.client.json('POST', '/api/devices', { name: 'Pat desktop' })).body
    const found = (await O.client.json('GET', `/api/operator/users?q=${encodeURIComponent(P.email)}`)).body
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: pId, email: P.email, spaces: 1, sessions: 1, devices: 1 })
    const off = await O.client.json('POST', `/api/operator/users/${pId}/disable`, { reason: 'Chargeback' })
    expect(off.status).toBe(200)
    expect(off.body).toMatchObject({ disabledAt: expect.any(Number), sessions: 0, devices: 0 })
    expect((await P.client.json('GET', '/api/auth/me')).status).toBe(401)
    expect((await t.app.request('/api/auth/me', { headers: { authorization: `Bearer ${dev.token}` } })).status).toBe(401)
    // a wrong password says what it always says; only the right one learns the account is disabled
    expect((await new Client(t.app).json('POST', '/api/auth/login', { email: P.email, password: 'wrong-wrong' })).status).toBe(401)
    const refused = await new Client(t.app).json('POST', '/api/auth/login', { email: P.email, password: 'correct-horse-1' })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toMatch(/disabled/)
    expect((await O.client.json('POST', `/api/operator/users/${O.id}/disable`, {})).status).toBe(409)
    expect((await O.client.json('POST', `/api/operator/users/${pId}/enable`)).body.disabledAt).toBeUndefined()
    expect((await new Client(t.app).json('POST', '/api/auth/login', { email: P.email, password: 'correct-horse-1' })).status).toBe(200)
    const detail = (await O.client.json('GET', `/api/operator/users/${pId}`)).body
    expect(detail.memberships).toHaveLength(1)
    expect(detail.recent.map((e: AuditEntry) => e.kind)).toEqual(expect.arrayContaining(['operator.user.disabled', 'operator.user.enabled', 'signin.failed', 'signin.ok']))
    expect((await entries({ kind: 'operator.user.disabled', targetId: pId }))[0]).toMatchObject({ actorId: O.id, data: { reason: 'Chargeback', sessions: 1, devices: 1 } })
  })

  it('makes a one-time reset link when mail is off (and refuses to mail it)', async () => {
    const O = await operator()
    const P = await signup(t.app, 'Locked Out')
    const pId = await me(P.client)
    expect((await O.client.json('POST', `/api/operator/users/${pId}/reset`, { mode: 'mail' })).status).toBe(409)
    const r = await O.client.json('POST', `/api/operator/users/${pId}/reset`, { mode: 'link' })
    expect(r.status).toBe(200)
    const token = String(r.body.url).split('/reset/')[1]
    expect((await new Client(t.app).json('GET', `/api/auth/reset/${token}`)).body.email).toBe(P.email)
    const fresh = new Client(t.app)
    expect((await fresh.json('POST', '/api/auth/reset', { token, password: 'brand-new-pass-1' })).status).toBe(200)
    expect((await P.client.json('GET', '/api/auth/me')).status).toBe(401)
    const [made] = await entries({ kind: 'operator.reset.link', targetId: pId })
    // the link itself is never written down
    expect(JSON.stringify(made)).not.toContain(token)
  })

  it('inspects any job with its raw error, requeues a failed one and cancels a waiting one', async () => {
    const O = await operator()
    const P = await signup(t.app, 'Job Owner')
    const pId = await me(P.client)
    const j = await enqueue('export.render', {}, { workspaceId: P.workspaceId, userId: pId })
    await ctx().db.update(jobs).set({ status: 'error', error: 'The export failed on the server.', errorDetail: 'Render failed (exit 1): /srv/data/renders/x/out.mp4 broke', attempts: 3 }).where(eq(jobs.id, j.id))
    const list = (await O.client.json('GET', `/api/operator/jobs?workspaceId=${P.workspaceId}&status=error`)).body
    expect(list.items.map((x: { id: string }) => x.id)).toEqual([j.id])
    const one = (await O.client.json('GET', `/api/operator/jobs/${j.id}`)).body
    expect(one).toMatchObject({ errorDetail: expect.stringContaining('/srv/data/renders'), error: 'The export failed on the server.', attempts: 3, input: {} })
    // the person never sees the raw error
    expect((await P.client.json('GET', `/api/jobs/${j.id}`)).body.errorDetail).toBeUndefined()
    const again = await O.client.json('POST', `/api/operator/jobs/${j.id}/requeue`)
    expect(again.body).toMatchObject({ status: 'queued', attempts: 0, message: 'Requeued by an operator' })
    expect((await O.client.json('POST', `/api/operator/jobs/${j.id}/requeue`)).status).toBe(409)
    const gone = await O.client.json('POST', `/api/operator/jobs/${j.id}/cancel`)
    expect(gone.body.status).toBe('cancelled')
    expect((await getJob(j.id))!.error).toBe('Cancelled by an operator')
    expect((await entries({ kind: 'operator.job.requeued', targetId: j.id }))[0]).toMatchObject({ actorId: O.id, workspaceId: P.workspaceId, data: { from: 'error' } })
    expect(await entries({ kind: 'operator.job.cancelled', targetId: j.id })).toHaveLength(1)
    // a non-operator can't reach any of it
    expect((await P.client.json('POST', `/api/operator/jobs/${j.id}/requeue`)).status).toBe(404)
  })

  it('shows storage per space, and removes orphaned objects only after a dry run, leaving new and owned ones', async () => {
    const O = await operator()
    const P = await signup(t.app, 'Storage Owner')
    const pId = await me(P.client)
    const s = ctx().storage
    const old = (Date.now() - 3 * 24 * 3600_000) / 1000
    const age = (key: string) => fs.utimesSync(s.localPath!(key), old, old)
    const { assets } = await import('../db/schema')
    await ctx().db.insert(assets).values({ id: `as_kept_${Date.now()}`, workspaceId: P.workspaceId, kind: 'video', name: 'kept.mp4', mime: 'video/mp4', size: 5000, status: 'ready', sourceKey: 'x', createdBy: pId, createdAt: Date.now(), updatedAt: Date.now() })
    const keptId = (await ctx().db.select({ id: assets.id }).from(assets).where(eq(assets.workspaceId, P.workspaceId)))[0].id
    const keys = {
      goneSpace: 'ws/ws_long_gone/assets/as_x/source.mp4',
      goneClip: `ws/${P.workspaceId}/assets/as_deleted_clip/proxy.mp4`,
      goneFont: `ws/${P.workspaceId}/brand-fonts/font_gone.woff2`,
      kept: `ws/${P.workspaceId}/assets/${keptId}/source.mp4`,
      fresh: 'ws/ws_just_now/assets/as_y/source.mp4',
    }
    for (const k of Object.values(keys)) await s.put(k, Buffer.from(`data for ${k}`))
    for (const k of [keys.goneSpace, keys.goneClip, keys.goneFont, keys.kept]) age(k)

    const usage = (await O.client.json('GET', `/api/operator/storage?q=${P.workspaceId}`)).body
    expect(usage[0]).toMatchObject({ workspaceId: P.workspaceId, bytes: 5000, files: 1, owner: P.email })

    const dry = (await O.client.json('POST', '/api/operator/storage/orphans', {})).body
    expect(dry.dryRun).toBe(true)
    const listed = new Map(dry.objects.map((o: { key: string; reason: string }) => [o.key, o.reason]))
    expect(listed.get(keys.goneSpace)).toBe('workspace')
    expect(listed.get(keys.goneClip)).toBe('asset')
    expect(listed.get(keys.goneFont)).toBe('font')
    expect(listed.has(keys.kept)).toBe(false)
    expect(listed.has(keys.fresh)).toBe(false)
    // nothing went yet
    expect(await s.stat(keys.goneSpace)).not.toBeNull()
    // another operator can't confirm this one's dry run; a made-up id is refused
    expect((await O.client.json('POST', '/api/operator/storage/orphans', { scanId: 'scan_madeup' })).status).toBe(410)
    const done = (await O.client.json('POST', '/api/operator/storage/orphans', { scanId: dry.scanId })).body
    expect(done.removed).toBeGreaterThanOrEqual(3)
    for (const k of [keys.goneSpace, keys.goneClip, keys.goneFont]) expect(await s.stat(k)).toBeNull()
    for (const k of [keys.kept, keys.fresh]) expect(await s.stat(k)).not.toBeNull()
    expect((await O.client.json('POST', '/api/operator/storage/orphans', { scanId: dry.scanId })).status).toBe(410)
    expect((await entries({ kind: 'operator.storage.orphans', actorId: O.id }))[0].data).toMatchObject({ removed: done.removed })
  })

  it('reads the whole audit log, filtered by person, space, kind or a request id', async () => {
    const O = await operator()
    const P = await signup(t.app, 'Search Me')
    const pId = await me(P.client)
    await new Client(t.app).req('POST', '/api/auth/login', JSON.stringify({ email: P.email, password: 'bad-bad-bad' }), { 'content-type': 'application/json', 'x-request-id': 'find-this-request' })
    const byReq = (await O.client.json('GET', '/api/operator/audit?q=find-this-request')).body.items
    expect(byReq).toHaveLength(1)
    expect(byReq[0]).toMatchObject({ kind: 'signin.failed', targetId: pId })
    const byUser = (await O.client.json('GET', `/api/operator/audit?userId=${pId}`)).body.items.map((e: AuditEntry) => e.kind)
    expect(byUser).toEqual(expect.arrayContaining(['signup', 'signin.failed']))
    expect((await O.client.json('GET', `/api/operator/audit?userId=${pId}&kind=signup`)).body.items).toHaveLength(1)
  })
})
