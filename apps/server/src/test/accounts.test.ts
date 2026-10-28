// Release 3, accounts and mail: the mail transport (A-1, P-22), invite email and Resend (A-1), handing a space over
// (A-2), the account page's routes (A-17), password reset, email checks and app-link limits (P-22), and job emails (A-8).
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { Client, setup, signup, type TestEnv } from './helpers'
import type { Mail, MailTransport } from '../mail'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

const db = async () => (await import('../context')).ctx().db
const schema = () => import('../db/schema')
const mail = () => import('../mail')

/** Mail goes to this list instead of anywhere real. */
async function fakeMail(): Promise<Mail[]> {
  const sent: Mail[] = []
  const transport: MailTransport = { name: 'fake', send: async (m) => void sent.push(m) }
  ;(await mail()).setMailTransport(transport)
  return sent
}

afterEach(async () => {
  ;(await mail()).setMailTransport(null)
})

const tokenIn = (m: Mail, path: string) => m.text.match(new RegExp(`${path}/([A-Za-z0-9_-]+)`))?.[1]
const userId = async (c: Client) => (await c.json('GET', '/api/auth/me')).body.user.id as string

function bearer(token: string) {
  return (method: string, url: string, body?: unknown) =>
    t.app.request(url, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
}

async function team() {
  const A = await signup(t.app, 'Ada Owner')
  const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Northwind' })).body as { id: string }
  const B = await signup(t.app, 'Ben Member')
  const inv = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: B.email, role: 'editor' })
  await B.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
  return { A, B, wsId: ws.id, aId: await userId(A.client), bId: await userId(B.client) }
}

describe('the mail transport', () => {
  it('posts to Resend with the key, sender, both parts, and reports a refusal', async () => {
    const { resendTransport, RESEND_URL } = await import('../mail/resend')
    const calls: Array<{ url: string; init: RequestInit }> = []
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('{"id":"x"}', { status: 200 })
    }) as unknown as typeof fetch
    await resendTransport('re_test', ok).send({ from: 'Studio <a@b.c>', to: 'x@y.z', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' })
    expect(calls[0].url).toBe(RESEND_URL)
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer re_test')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ from: 'Studio <a@b.c>', to: ['x@y.z'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' })
    const refused = (async () => new Response('{"message":"domain not verified"}', { status: 403 })) as unknown as typeof fetch
    await expect(resendTransport('re_test', refused).send({ from: 'a@b.c', to: 'x@y.z', subject: 's', html: 'h', text: 't' })).rejects.toThrow(/403: domain not verified/)
  })

  it('is off unless RESEND_API_KEY and MAIL_FROM are both set, and the desktop never mails', async () => {
    const { loadConfig } = await import('../config')
    expect(loadConfig({ RESEND_API_KEY: 're_x' } as NodeJS.ProcessEnv).mail).toBeUndefined()
    expect(loadConfig({ RESEND_API_KEY: 're_x', MAIL_FROM: 'S <s@x.y>' } as NodeJS.ProcessEnv).mail).toEqual({ resendApiKey: 're_x', from: 'S <s@x.y>' })
    expect(loadConfig({ RESEND_API_KEY: 're_x', MAIL_FROM: 'S <s@x.y>', MODE: 'desktop' } as NodeJS.ProcessEnv).mail).toBeUndefined()
    const m = await mail()
    m.setMailTransport(undefined)
    expect(m.mailEnabled()).toBe(false)
    expect(await m.sendMail({ to: 'a@b.c', subject: 's', html: 'h', text: 't' })).toBe(false)
    expect((await new Client(t.app).json('GET', '/api/system')).body.mail).toBe(false)
  })

  it('escapes what people typed into the HTML part', async () => {
    const { inviteMail } = await import('../mail/messages')
    const m = inviteMail({ to: 'x@y.z', inviter: '<b>Eve</b>', space: 'A & B', role: 'editor', url: 'https://app/invite/t', expiresAt: Date.UTC(2026, 10, 4) })
    expect(m.html).toContain('&lt;b&gt;Eve&lt;/b&gt;')
    expect(m.html).not.toContain('<b>Eve</b>')
    expect(m.text).toContain('Producer Studio · A & B')
    expect(m.text).toContain('4 November 2026')
  })
})

describe('invite email, resend and the pending list (A-1)', () => {
  it('mails the invite with the space, role and link, and lists when it was sent', async () => {
    const sent = await fakeMail()
    const A = await signup(t.app, 'Ada Owner')
    const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Northwind' })).body
    sent.length = 0
    const r = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: 'New.Person@Example.com', role: 'viewer' })
    expect(r.body).toMatchObject({ ok: true, emailed: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'new.person@example.com', subject: 'Ada Owner invited you to Northwind on Producer Studio' })
    expect(sent[0].text).toContain('as a viewer')
    expect(tokenIn(sent[0], '/invite')).toBe(r.body.inviteUrl.split('/invite/')[1])
    expect(sent[0].html).toContain('Producer Studio · Northwind')
    const list = (await A.client.json('GET', `/api/workspaces/${ws.id}/invites`)).body
    expect(list[0]).toMatchObject({ email: 'new.person@example.com', status: 'pending', sentAt: expect.any(Number) })
  })

  it('without mail the invite is made and its link handed back to copy', async () => {
    const A = await signup(t.app)
    const r = await A.client.json('POST', `/api/workspaces/${A.workspaceId}/invites`, { email: 'x@example.com' })
    expect(r.body).toMatchObject({ ok: true, emailed: false, inviteUrl: expect.stringContaining('/invite/') })
  })

  it('Resend mails it again with a fresh 7 days, not twice in a minute; expired invites stay listed to resend', async () => {
    const sent = await fakeMail()
    const A = await signup(t.app)
    sent.length = 0
    const r = await A.client.json('POST', `/api/workspaces/${A.workspaceId}/invites`, { email: 'late@example.com' })
    const token = r.body.inviteUrl.split('/invite/')[1]
    expect((await A.client.json('POST', `/api/workspaces/${A.workspaceId}/invites/${token}/resend`)).status).toBe(429)
    // a week later: expired, still in the list
    const { invites } = await schema()
    await (await db()).update(invites).set({ expiresAt: Date.now() - 1000, sentAt: Date.now() - 2 * 60_000 }).where(eq(invites.token, token))
    expect((await A.client.json('GET', `/api/workspaces/${A.workspaceId}/invites`)).body.find((i: { token: string }) => i.token === token).status).toBe('expired')
    const again = await A.client.json('POST', `/api/workspaces/${A.workspaceId}/invites/${token}/resend`)
    expect(again.body).toMatchObject({ status: 'pending', emailed: true })
    expect(again.body.expiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000)
    expect(sent.map((m) => m.to)).toEqual(['late@example.com', 'late@example.com'])
    const row = (await (await db()).select().from(invites).where(eq(invites.token, token)))[0]
    expect(row.sends).toBe(2)
    // only owners; a withdrawn invite can't be resent
    const B = await signup(t.app)
    expect((await B.client.json('POST', `/api/workspaces/${A.workspaceId}/invites/${token}/resend`)).status).toBe(404)
    await A.client.json('DELETE', `/api/workspaces/${A.workspaceId}/invites/${token}`)
    expect((await A.client.json('POST', `/api/workspaces/${A.workspaceId}/invites/${token}/resend`)).status).toBe(404)
  })
})

describe('handing a space over (A-2)', () => {
  it('makes the member an owner and the owner an editor in one step; never on a personal space', async () => {
    const { A, B, wsId, aId, bId } = await team()
    expect((await B.client.json('POST', `/api/workspaces/${wsId}/members/${aId}/transfer`)).status).toBe(403)
    expect((await A.client.json('POST', `/api/workspaces/${wsId}/members/${aId}/transfer`)).status).toBe(400)
    expect((await A.client.json('POST', `/api/workspaces/${wsId}/members/${bId}/transfer`)).body).toEqual({ ok: true })
    const roles = Object.fromEntries((await B.client.json('GET', `/api/workspaces/${wsId}/members`)).body.map((m: { userId: string; role: string }) => [m.userId, m.role]))
    expect(roles).toEqual({ [aId]: 'editor', [bId]: 'owner' })
    // A can leave now; B (the only owner) can't
    expect((await B.client.json('DELETE', `/api/workspaces/${wsId}/members/${bId}`)).status).toBe(409)
    expect((await A.client.json('DELETE', `/api/workspaces/${wsId}/members/${aId}`)).status).toBe(200)
    expect((await A.client.json('POST', `/api/workspaces/${A.workspaceId}/members/${bId}/transfer`)).status).toBe(409)
  })
})

describe('password reset (P-22, A-17)', () => {
  it('with mail off says so and sends nothing', async () => {
    const A = await signup(t.app)
    expect((await new Client(t.app).json('POST', '/api/auth/forgot', { email: A.email })).body).toEqual({ ok: true, mail: false })
  })

  it('mails a single-use link, kept hashed; the new password signs out every other session and app', async () => {
    const sent = await fakeMail()
    const A = await signup(t.app, 'Riley')
    sent.length = 0
    const dev = (await A.client.json('POST', '/api/devices', { name: 'Laptop' })).body.token
    const anon = new Client(t.app)
    // the same answer for an unknown address, and nothing sent
    expect((await anon.json('POST', '/api/auth/forgot', { email: 'nobody-here@example.com' })).body).toEqual({ ok: true, mail: true })
    expect(sent).toHaveLength(0)
    expect((await anon.json('POST', '/api/auth/forgot', { email: A.email.toUpperCase() })).body).toEqual({ ok: true, mail: true })
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe('Reset your Producer Studio password')
    const token = tokenIn(sent[0], '/reset')!
    const { authTokens } = await schema()
    const rows = await (await db()).select().from(authTokens).where(eq(authTokens.email, A.email))
    expect(rows.some((r) => r.id === token)).toBe(false)
    expect((await anon.json('GET', `/api/auth/reset/${token}`)).body).toEqual({ email: A.email })
    expect((await anon.json('POST', '/api/auth/reset', { token, password: 'short' })).status).toBe(400)
    const done = await anon.json('POST', '/api/auth/reset', { token, password: 'brand-new-pass-9' })
    expect(done.status).toBe(200)
    expect(done.body.user.emailVerified).toBe(true)
    // this browser is in; the old session and the app link are out; the link is spent
    expect((await anon.json('GET', '/api/auth/me')).status).toBe(200)
    expect((await A.client.json('GET', '/api/auth/me')).status).toBe(401)
    expect((await bearer(dev)('GET', '/api/auth/me')).status).toBe(401)
    expect((await new Client(t.app).json('POST', '/api/auth/reset', { token, password: 'another-pass-99' })).status).toBe(410)
    expect((await new Client(t.app).json('POST', '/api/auth/login', { email: A.email, password: 'brand-new-pass-9' })).status).toBe(200)
    expect(sent.at(-1)!.subject).toBe('Your Producer Studio password was changed')
  })

  it('expires, a newer link cancels the older one, and an account gets at most 3 an hour', async () => {
    const sent = await fakeMail()
    const A = await signup(t.app)
    sent.length = 0
    const anon = new Client(t.app)
    await anon.json('POST', '/api/auth/forgot', { email: A.email })
    await anon.json('POST', '/api/auth/forgot', { email: A.email })
    const [first, second] = sent.map((m) => tokenIn(m, '/reset')!)
    expect((await anon.json('GET', `/api/auth/reset/${first}`)).status).toBe(410)
    expect((await anon.json('GET', `/api/auth/reset/${second}`)).status).toBe(200)
    const { authTokens } = await schema()
    const { sha256 } = await import('../ids')
    await (await db()).update(authTokens).set({ expiresAt: Date.now() - 1 }).where(eq(authTokens.id, sha256(second)))
    expect((await anon.json('POST', '/api/auth/reset', { token: second, password: 'whatever-pass-1' })).status).toBe(410)
    await anon.json('POST', '/api/auth/forgot', { email: A.email })
    await anon.json('POST', '/api/auth/forgot', { email: A.email })
    expect(sent).toHaveLength(3)
    expect((await anon.json('GET', '/api/auth/reset/not-a-real-token-at-all')).status).toBe(404)
  })

  it('one network can ask for only so many account mails an hour', async () => {
    const { authTokens } = await schema()
    const { checkTokenIpRate, TOKENS_PER_IP_PER_HOUR } = await import('../services/account')
    const A = await signup(t.app)
    const uid = await userId(A.client)
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}-${Date.now()}`
    await expect(checkTokenIpRate(ip)).resolves.toBeUndefined()
    await (await db()).insert(authTokens).values(
      Array.from({ length: TOKENS_PER_IP_PER_HOUR }, (_, i) => ({ id: `t-${ip}-${i}`, userId: uid, purpose: 'reset', email: A.email, ip, createdAt: Date.now(), expiresAt: Date.now() + 60_000 })),
    )
    await expect(checkTokenIpRate(ip)).rejects.toMatchObject({ status: 429 })
  })
})

describe('email confirmation and change (P-22, A-17)', () => {
  it('a new account is sent a confirmation; using it marks the address confirmed', async () => {
    const sent = await fakeMail()
    const A = await signup(t.app, 'Sam')
    expect(sent[0]).toMatchObject({ to: A.email, subject: 'Confirm your email for Producer Studio' })
    expect((await A.client.json('GET', '/api/account')).body).toMatchObject({ emailVerified: false, mail: true })
    const r = await new Client(t.app).json('POST', '/api/auth/verify', { token: tokenIn(sent[0], '/verify') })
    expect(r.body).toEqual({ ok: true, email: A.email, purpose: 'verify' })
    expect((await A.client.json('GET', '/api/auth/me')).body.user.emailVerified).toBe(true)
  })

  it('a new address changes only once confirmed from its inbox, and the old one is told', async () => {
    const A = await signup(t.app, 'Kim')
    const sent = await fakeMail()
    const newEmail = `kim-new-${Date.now()}@example.com`
    expect((await A.client.json('POST', '/api/account/email', { email: newEmail, password: 'wrong-pass-123' })).status).toBe(403)
    const r = await A.client.json('POST', '/api/account/email', { email: newEmail, password: 'correct-horse-1' })
    expect(r.body).toEqual({ ok: true, pending: newEmail })
    expect((await A.client.json('GET', '/api/account')).body).toMatchObject({ user: { email: A.email }, pendingEmail: newEmail })
    await new Client(t.app).json('POST', '/api/auth/verify', { token: tokenIn(sent[0], '/verify') })
    expect((await A.client.json('GET', '/api/account')).body).toMatchObject({ user: { email: newEmail }, emailVerified: true })
    expect(sent[1]).toMatchObject({ to: A.email, subject: 'Your Producer Studio email was changed' })
    // someone else can't take the address
    const B = await signup(t.app)
    expect((await B.client.json('POST', '/api/account/email', { email: newEmail, password: 'correct-horse-1' })).status).toBe(409)
  })

  it('with mail off the change is made at once, unconfirmed', async () => {
    const A = await signup(t.app)
    const newEmail = `direct-${Date.now()}@example.com`
    expect((await A.client.json('POST', '/api/account/email', { email: newEmail, password: 'correct-horse-1' })).body).toEqual({ ok: true, email: newEmail })
    expect((await A.client.json('GET', '/api/account')).body).toMatchObject({ user: { email: newEmail }, emailVerified: false, mail: false })
  })
})

describe('the account (A-17)', () => {
  it('edits the profile, changes the password and keeps only this session', async () => {
    const A = await signup(t.app, 'Alex')
    const other = new Client(t.app)
    await other.json('POST', '/api/auth/login', { email: A.email, password: 'correct-horse-1' })
    const p = await A.client.json('PATCH', '/api/account', { name: 'Alex Rivera', avatarColor: '#7c5cff' })
    expect(p.body.user).toMatchObject({ name: 'Alex Rivera', avatarColor: '#7c5cff' })
    expect((await A.client.json('PATCH', '/api/account', { avatarColor: 'red' })).status).toBe(400)
    expect((await A.client.json('POST', '/api/account/password', { current: 'nope-nope-1', password: 'next-password-1' })).status).toBe(403)
    expect((await A.client.json('POST', '/api/account/password', { current: 'correct-horse-1', password: 'next-password-1' })).body).toEqual({ ok: true })
    expect((await A.client.json('GET', '/api/auth/me')).status).toBe(200)
    expect((await other.json('GET', '/api/auth/me')).status).toBe(401)
  })

  it('lists sessions with the current one first, ends one, or every other one and every app link', async () => {
    const A = await signup(t.app)
    const B = new Client(t.app)
    await B.json('POST', '/api/auth/login', { email: A.email, password: 'correct-horse-1' })
    const dev = (await A.client.json('POST', '/api/devices', { name: 'Desk' })).body.token
    const list = (await A.client.json('GET', '/api/account/sessions')).body
    expect(list).toHaveLength(2)
    expect(list[0].current).toBe(true)
    expect(list[1]).toMatchObject({ current: false, createdAt: expect.any(Number), expiresAt: expect.any(Number) })
    expect((await A.client.json('DELETE', `/api/account/sessions/${list[1].id}`)).body).toEqual({ ok: true })
    expect((await B.json('GET', '/api/auth/me')).status).toBe(401)
    // another person can't end my sessions
    const C = await signup(t.app)
    expect((await C.client.json('DELETE', `/api/account/sessions/${list[0].id}`)).status).toBe(404)
    await B.json('POST', '/api/auth/login', { email: A.email, password: 'correct-horse-1' })
    expect((await A.client.json('POST', '/api/account/sign-out-everywhere')).body).toEqual({ ok: true, sessions: 1, devices: 1 })
    expect((await B.json('GET', '/api/auth/me')).status).toBe(401)
    expect((await bearer(dev)('GET', '/api/auth/me')).status).toBe(401)
    expect((await A.client.json('GET', '/api/auth/me')).status).toBe(200)
  })

  it('notification choices default to browser on, email off', async () => {
    const A = await signup(t.app)
    expect((await A.client.json('GET', '/api/account')).body.notifications).toEqual({ browser: true, emailJobs: false })
    expect((await A.client.json('PUT', '/api/account/notifications', { emailJobs: true })).body).toEqual({ browser: true, emailJobs: true })
    expect((await A.client.json('PUT', '/api/account/notifications', { sms: true })).status).toBe(400)
    expect((await A.client.json('GET', '/api/account')).body.notifications.emailJobs).toBe(true)
  })

  it('deleting is refused while they are the only owner of a space others use; after a hand-over it goes', async () => {
    const { A, B, wsId, aId, bId } = await team()
    const info = (await A.client.json('GET', '/api/account')).body
    expect(info.soleOwnerOf).toEqual([{ id: wsId, name: 'Northwind' }])
    expect((await A.client.json('DELETE', '/api/account', { password: 'wrong-pass-1' })).status).toBe(403)
    const refused = await A.client.json('DELETE', '/api/account', { password: 'correct-horse-1' })
    expect(refused.status).toBe(409)
    expect(refused.body.details.spaces).toEqual([{ id: wsId, name: 'Northwind' }])
    await A.client.json('POST', `/api/workspaces/${wsId}/members/${bId}/transfer`)
    expect((await A.client.json('DELETE', '/api/account', { password: 'correct-horse-1' })).body).toEqual({ ok: true })
    expect((await A.client.json('GET', '/api/auth/me')).status).toBe(401)
    expect((await new Client(t.app).json('POST', '/api/auth/login', { email: A.email, password: 'correct-horse-1' })).status).toBe(401)
    // the shared space carries on without them; their personal space is gone
    const members = (await B.client.json('GET', `/api/workspaces/${wsId}/members`)).body
    expect(members.map((m: { userId: string }) => m.userId)).toEqual([bId])
    const { workspaces } = await schema()
    expect(await (await db()).select().from(workspaces).where(eq(workspaces.id, A.workspaceId))).toEqual([])
    expect(aId).toBeTruthy()
  })
})

describe('app links can only sync (P-22)', () => {
  it('a device token reaches the sync routes but not the account, members, invites or AI', async () => {
    const { A, wsId, bId } = await team()
    const dev = bearer((await A.client.json('POST', '/api/devices', { name: 'Desk' })).body.token)
    expect((await dev('GET', '/api/auth/me')).status).toBe(200)
    expect((await dev('GET', `/api/projects?workspaceId=${wsId}`)).status).toBe(200)
    expect((await dev('GET', `/api/sync/changes?since=0`)).status).toBe(200)
    const refused = await dev('GET', '/api/account')
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { error: string }).error).toMatch(/can only sync/)
    expect((await dev('POST', '/api/account/sign-out-everywhere')).status).toBe(403)
    expect((await dev('POST', '/api/account/password', { current: 'correct-horse-1', password: 'taken-over-1' })).status).toBe(403)
    expect((await dev('GET', `/api/workspaces/${wsId}/members`)).status).toBe(403)
    expect((await dev('POST', `/api/workspaces/${wsId}/invites`, { email: 'evil@example.com' })).status).toBe(403)
    expect((await dev('PATCH', `/api/workspaces/${wsId}/members/${bId}`, { role: 'viewer' })).status).toBe(403)
    expect((await dev('POST', '/api/ai/write', { prompt: 'x' })).status).toBe(403)
    const devices = (await A.client.json('GET', '/api/devices')).body
    expect(devices[0].expiresAt).toBeGreaterThan(Date.now() + 89 * 24 * 3600_000)
  })
})

describe('job emails (A-8)', () => {
  async function endedJob(o: { userId: string; workspaceId: string; kind?: string; status?: string; ranMs?: number; error?: string; input?: Record<string, unknown> }) {
    const { jobs } = await schema()
    const { newId } = await import('../ids')
    const now = Date.now()
    const [row] = await (await db())
      .insert(jobs)
      .values({
        id: newId('j'),
        kind: o.kind ?? 'export.render',
        status: o.status ?? 'done',
        progress: 1,
        message: 'Done',
        input: o.input ?? {},
        workspaceId: o.workspaceId,
        userId: o.userId,
        error: o.error ?? null,
        createdAt: now - (o.ranMs ?? 5 * 60_000),
        updatedAt: now,
      })
      .returning()
    return row
  }

  it('mails the person who started a long job when they chose to, and only then', async () => {
    const sent = await fakeMail()
    const A = await signup(t.app, 'Jo')
    sent.length = 0
    const uid = await userId(A.client)
    const { jobEnded, jobLink } = await import('../services/notify')
    // off by default
    expect(await jobEnded(await endedJob({ userId: uid, workspaceId: A.workspaceId }))).toBe(false)
    await A.client.json('PUT', '/api/account/notifications', { emailJobs: true })
    expect(await jobEnded(await endedJob({ userId: uid, workspaceId: A.workspaceId }))).toBe(true)
    expect(sent[0]).toMatchObject({ to: A.email, subject: 'Your export is ready' })
    expect(sent[0].text).toContain("Producer Studio · Jo's space")
    expect(await jobEnded(await endedJob({ userId: uid, workspaceId: A.workspaceId, kind: 'ai.produce.assemble', status: 'error', error: 'No footage' }))).toBe(true)
    expect(sent[1].subject).toBe('Your Producer AI video failed')
    expect(sent[1].text).toContain('What went wrong: No footage')
    // quick jobs, uploads, draft previews and cancellations send nothing
    expect(await jobEnded(await endedJob({ userId: uid, workspaceId: A.workspaceId, ranMs: 5000 }))).toBe(false)
    expect(await jobEnded(await endedJob({ userId: uid, workspaceId: A.workspaceId, kind: 'asset.process' }))).toBe(false)
    expect(await jobEnded(await endedJob({ userId: uid, workspaceId: A.workspaceId, input: { preview: true } }))).toBe(false)
    expect(await jobEnded(await endedJob({ userId: uid, workspaceId: A.workspaceId, status: 'cancelled' }))).toBe(false)
    expect(sent).toHaveLength(2)
    expect(jobLink({ kind: 'export.render', projectId: 'p_1' })).toBe('/edit/p_1?export=1')
    expect(jobLink({ kind: 'ai.produce.assemble', projectId: 'p_1' })).toBe('/producer/p_1')
  })

  it('is sent from the queue when a job ends', async () => {
    const sent = await fakeMail()
    const A = await signup(t.app, 'Lee')
    sent.length = 0
    const uid = await userId(A.client)
    await A.client.json('PUT', '/api/account/notifications', { emailJobs: true })
    const { enqueue, failJob } = await import('../jobs/queue')
    const { jobs } = await schema()
    const j = await enqueue('ai.tts', {}, { workspaceId: A.workspaceId, userId: uid })
    await (await db()).update(jobs).set({ status: 'running', createdAt: Date.now() - 2 * 60_000 }).where(eq(jobs.id, j.id))
    await failJob(j.id, 'The voice engine stopped')
    await new Promise((r) => setTimeout(r, 100))
    expect(sent.map((m) => m.subject)).toEqual(['The voiceover failed'])
    // the job list says who started it, so only their own tab announces it
    expect((await A.client.json('GET', `/api/jobs/${j.id}`)).body.startedBy).toBe(uid)
  })
})
