// Sign-up from a membership website (meyousocial.com): its signed server-to-server calls make a space (and the account,
// for a new email), keep the membership's plan, status and seats in step, and hand the member one-time sign-in links;
// a space's owner can claim a membership bought on the website for a space that already exists. The contract the
// website builds against is docs/integrations/meyousocial.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { ctx } from '../context'
import { users, workspacePlans } from '../db/schema'
import { builtinAiEnabled } from '../services/metering'
import { signedHeaders } from '../services/membership'
import { Client, setup, signup, type TestEnv } from './helpers'

const SECRET = 'test-provision-secret-0123456789abcdef-xyz'
let t: TestEnv
let n = 0
const ext = () => `mp-sub-${Date.now()}-${++n}`
const mail = () => `member${Date.now()}${++n}@example.com`

beforeAll(async () => {
  t = await setup()
  ctx().config.provisionSecret = SECRET
  ctx().config.membershipUrl = 'https://www.meyousocial.com/join/'
})
afterAll(() => {
  ctx().config.provisionSecret = undefined
})

/** A call signed the way the website signs it (or with what a test passes instead). */
async function call(method: string, path: string, body: unknown, o: { secret?: string; now?: number; headers?: Record<string, string>; raw?: string } = {}) {
  const raw = o.raw ?? JSON.stringify(body)
  const res = await t.app.request(path, { method, headers: { 'content-type': 'application/json', ...signedHeaders(o.secret ?? SECRET, raw, o.now), ...(o.headers ?? {}) }, body: raw })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

/** Follow a sign-in link in a fresh browser: signed in, as whom, and needing a password or not. */
async function follow(url: string) {
  const browser = new Client(t.app)
  const token = /\/link\/([^?]+)/.exec(url)![1]
  const r = await browser.json('POST', '/api/auth/link', { token })
  return { browser, r }
}

describe('signed calls', () => {
  it('answers a correctly signed ping, and refuses a missing, wrong, stale or replayed signature', async () => {
    expect(await call('POST', '/api/provision/ping', {})).toMatchObject({ status: 200, body: { ok: true, server: 'producer-studio' } })
    const raw = JSON.stringify({})
    expect((await t.app.request('/api/provision/ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).status).toBe(401)
    expect((await call('POST', '/api/provision/ping', {}, { secret: 'another-secret-another-secret-another' })).body.error).toBe('Bad signature')
    expect((await call('POST', '/api/provision/ping', {}, { now: Date.now() - 6 * 60_000 })).body.error).toMatch(/more than 5 minutes/)
    // seconds instead of milliseconds are fine
    const secs = String(Math.floor(Date.now() / 1000))
    const { createHmac } = await import('node:crypto')
    const sig = createHmac('sha256', SECRET).update(`${secs}.${raw}`).digest('hex')
    const once = { 'content-type': 'application/json', 'x-ps-timestamp': secs, 'x-ps-signature': `sha256=${sig}` }
    expect((await t.app.request('/api/provision/ping', { method: 'POST', headers: once, body: raw })).status).toBe(200)
    // the same signed request again: refused
    const again = await t.app.request('/api/provision/ping', { method: 'POST', headers: once, body: raw })
    expect(again.status).toBe(401)
    expect((await again.json()).error).toBe('This signed request was already used')
    // a body changed after signing: refused
    expect((await call('POST', '/api/provision/ping', {}, { raw: '{"x":1}', headers: signedHeaders(SECRET, '{}') })).status).toBe(401)
  })

  it('is off without a secret', async () => {
    ctx().config.provisionSecret = undefined
    try {
      expect((await call('POST', '/api/provision/ping', {})).status).toBe(404)
    } finally {
      ctx().config.provisionSecret = SECRET
    }
  })
})

describe('signup from the website', () => {
  it('a new email: an account with no password yet, its space with the membership, the server AI on, and a sign-in link that works once', async () => {
    const email = mail()
    const externalId = ext()
    const r = await call('POST', '/api/provision/signup', { externalId, email, name: 'Maya Lee', plan: 'member', workspaceName: 'Maya Films' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      user: { email, created: true, needsPassword: true },
      workspace: { name: 'Maya Films', created: true },
      membership: { source: 'meyousocial', externalId, plan: 'member', status: 'active', seats: null },
      signIn: { url: expect.stringMatching(/\/link\/[\w-]+\?ws=ws_/) },
    })
    const ws = r.body.workspace.id
    expect(await builtinAiEnabled(ws)).toBe(true)
    // the same signup again (a retried webhook): the same space, nothing new
    const again = await call('POST', '/api/provision/signup', { externalId, email, name: 'Maya Lee', plan: 'member' })
    expect(again.body).toMatchObject({ user: { created: false }, workspace: { id: ws, created: false } })
    // each answer brings a fresh link and the one before stops working (send the member to the latest)
    expect((await follow(r.body.signIn.url)).r.status).toBe(410)
    // the member follows the link: signed in to that space, asked to choose a password
    const { browser, r: me } = await follow(again.body.signIn.url)
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ user: { email }, needsPassword: true })
    expect(me.body.workspaces.map((w: { id: string }) => w.id)).toEqual([ws])
    // no password can sign in yet; choosing one needs no current password, then it works like any other
    expect((await new Client(t.app).json('POST', '/api/auth/login', { email, password: '' })).status).toBe(401)
    expect((await browser.json('POST', '/api/account/password', { password: 'my-new-password-1' })).status).toBe(200)
    expect((await new Client(t.app).json('POST', '/api/auth/login', { email, password: 'my-new-password-1' })).status).toBe(200)
    expect((await browser.json('GET', '/api/auth/me')).body.needsPassword).toBeUndefined()
    // now it has one, changing it asks for it as usual
    expect((await browser.json('POST', '/api/account/password', { password: 'another-password-2' })).status).toBe(403)
    // the link was used: it doesn't work again
    expect((await follow(again.body.signIn.url)).r.status).not.toBe(200)
  })

  it('an email that already has an account: a new space for it, the account untouched', async () => {
    const A = await signup(t.app, 'Existing Person')
    const r = await call('POST', '/api/provision/signup', { externalId: ext(), email: A.email.toUpperCase(), name: 'Existing Person', plan: 'contributor' })
    expect(r.body).toMatchObject({ user: { created: false, needsPassword: false }, workspace: { created: true, name: "Existing's space" } })
    const mine = (await A.client.json('GET', '/api/workspaces')).body as Array<{ id: string }>
    expect(mine.map((w) => w.id)).toContain(r.body.workspace.id)
    expect(mine.map((w) => w.id)).toContain(A.workspaceId)
    expect((await follow(r.body.signIn.url)).r.body.needsPassword).toBeUndefined()
  })

  it('the same signup sent twice at once makes one space; links are on PUBLIC_URL, else the address the call came to', async () => {
    const body = { externalId: ext(), email: mail(), name: 'Twin Calls', plan: 'member' }
    const now = Date.now()
    const [a, b] = await Promise.all([call('POST', '/api/provision/signup', body, { now }), call('POST', '/api/provision/signup', body, { now: now + 1 })])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.body.workspace.id).toBe(b.body.workspace.id)
    expect([a.body.workspace.created, b.body.workspace.created].sort()).toEqual([false, true])
    expect(a.body.signIn.url.startsWith('http://localhost/link/')).toBe(true)
    ctx().config.publicUrl = 'https://producerstudio.app/'
    try {
      const c = await call('POST', '/api/provision/sign-in-links', { externalId: body.externalId })
      expect(c.body.url.startsWith('https://producerstudio.app/link/')).toBe(true)
    } finally {
      ctx().config.publicUrl = undefined
    }
  })

  it('rejects what it can’t use, plainly', async () => {
    const bad = await call('POST', '/api/provision/signup', { externalId: ext(), email: 'not-an-email', name: 'X', plan: 'Gold Plan!' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/email/)
    expect(bad.body.error).toMatch(/plan/)
  })
})

describe('membership changes', () => {
  it('a membership that ends turns the server AI off, and the owner can’t turn it back on until it’s renewed', async () => {
    const externalId = ext()
    const r = await call('POST', '/api/provision/signup', { externalId, email: mail(), name: 'Sam Ortiz', plan: 'member' })
    const ws = r.body.workspace.id
    const { browser } = await follow(r.body.signIn.url)
    const ended = await call('PUT', `/api/provision/memberships/${externalId}`, { status: 'cancelled' })
    expect(ended.body.membership).toMatchObject({ status: 'cancelled', plan: 'member' })
    expect(await builtinAiEnabled(ws)).toBe(false)
    const tryOn = await browser.json('PUT', '/api/usage/builtin-ai', { workspaceId: ws, enabled: true })
    expect(tryOn.status).toBe(409)
    expect(tryOn.body.error).toMatch(/membership has ended.*meyousocial\.com\/join/)
    // renewed, on a bigger plan: on again
    const back = await call('PUT', `/api/provision/memberships/${externalId}`, { status: 'active', plan: 'steward' })
    expect(back.body.membership).toMatchObject({ status: 'active', plan: 'steward' })
    expect(await builtinAiEnabled(ws)).toBe(true)
    // read back with a signed read; unknown ids are 404
    expect((await call('POST', `/api/provision/memberships/${externalId}/read`, {})).body.membership).toMatchObject({ plan: 'steward', workspaceId: ws })
    expect((await call('PUT', '/api/provision/memberships/nope', { status: 'active' })).status).toBe(404)
    // the space shows it in its settings
    expect((await browser.json('GET', `/api/workspaces/${ws}/membership`)).body).toMatchObject({ membership: { plan: 'steward', status: 'active' }, membershipUrl: 'https://www.meyousocial.com/join/', canClaim: false })
  })

  it('a member owner can turn the server AI off and on again; a non-member owner can’t turn it on', async () => {
    const r = await call('POST', '/api/provision/signup', { externalId: ext(), email: mail(), name: 'Kim Member', plan: 'member' })
    const ws = r.body.workspace.id
    const { browser } = await follow(r.body.signIn.url)
    expect((await browser.json('PUT', '/api/usage/builtin-ai', { workspaceId: ws, enabled: false })).status).toBe(200)
    expect((await browser.json('PUT', '/api/usage/builtin-ai', { workspaceId: ws, enabled: true })).body).toEqual({ enabled: true })
    const free = await signup(t.app, 'Free Signup')
    const no = await free.client.json('PUT', '/api/usage/builtin-ai', { workspaceId: free.workspaceId, enabled: true })
    expect(no.status).toBe(409)
    expect(no.body.error).toMatch(/comes with a membership: get one for this space on its Members page \(from https:\/\/www\.meyousocial\.com\/join\/\)/)
    expect(await builtinAiEnabled(free.workspaceId)).toBe(false)
  })

  it('seats: members and pending invitations together, at most the membership’s seats', async () => {
    const externalId = ext()
    const r = await call('POST', '/api/provision/signup', { externalId, email: mail(), name: 'Ana Ruiz', plan: 'founder', seats: 2 })
    const ws = r.body.workspace.id
    const { browser } = await follow(r.body.signIn.url)
    expect((await browser.json('POST', `/api/workspaces/${ws}/invites`, { email: mail() })).status).toBe(200)
    const full = await browser.json('POST', `/api/workspaces/${ws}/invites`, { email: mail() })
    expect(full.status).toBe(409)
    expect(full.body.error).toMatch(/2 seats, all taken/)
    // more seats bought: room again
    await call('PUT', `/api/provision/memberships/${externalId}`, { seats: 3 })
    expect((await browser.json('POST', `/api/workspaces/${ws}/invites`, { email: mail() })).status).toBe(200)
  })
})

describe('sign-in links and claims', () => {
  it('a sign-in link by email or by membership; none for an email with no account', async () => {
    const externalId = ext()
    const email = mail()
    const r = await call('POST', '/api/provision/signup', { externalId, email, name: 'Lee Park', plan: 'member' })
    const byEmail = await call('POST', '/api/provision/sign-in-links', { email })
    expect(byEmail.body).toMatchObject({ url: expect.stringMatching(/\/link\//), expiresAt: expect.any(Number) })
    expect(byEmail.body.url).not.toMatch(/\?ws=/)
    const byMembership = await call('POST', '/api/provision/sign-in-links', { externalId })
    expect(byMembership.body.url).toMatch(new RegExp(`\\?ws=${r.body.workspace.id}$`))
    // a new link replaces the one before it
    expect((await follow(byEmail.body.url)).r.status).not.toBe(200)
    expect((await follow(byMembership.body.url)).r.status).toBe(200)
    expect((await call('POST', '/api/provision/sign-in-links', { email: mail() })).status).toBe(404)
    expect((await call('POST', '/api/provision/sign-in-links', {})).status).toBe(400)
  })

  it('a space made in the app gets the membership bought on the website through its owner’s claim', async () => {
    const A = await signup(t.app, 'App Signup')
    const viewer = await signup(t.app, 'Not The Owner')
    expect((await A.client.json('GET', `/api/workspaces/${A.workspaceId}/membership`)).body).toEqual({ membershipUrl: 'https://www.meyousocial.com/join/', canClaim: true })
    const claim = await A.client.json('POST', `/api/workspaces/${A.workspaceId}/membership/claim`)
    expect(claim.status).toBe(200)
    expect(claim.body.url).toMatch(/^https:\/\/www\.meyousocial\.com\/join\/\?ps_claim=v1\./)
    expect((await viewer.client.json('POST', `/api/workspaces/${A.workspaceId}/membership/claim`)).status).toBe(404)
    // the website passes the claim with the signup it makes after checkout: the membership goes on that space
    const externalId = ext()
    const r = await call('POST', '/api/provision/signup', { externalId, email: 'whatever-they-typed@example.com', name: 'App Signup', plan: 'contributor', claim: claim.body.claim })
    expect(r.body).toMatchObject({ user: { created: false }, workspace: { id: A.workspaceId, created: false }, membership: { plan: 'contributor', status: 'active' } })
    expect(await builtinAiEnabled(A.workspaceId)).toBe(true)
    expect((await A.client.json('GET', `/api/workspaces/${A.workspaceId}/membership`)).body).toMatchObject({ membership: { plan: 'contributor' }, canClaim: false })
    // a second claim for a space with an active membership, or a forged one: refused
    expect((await A.client.json('POST', `/api/workspaces/${A.workspaceId}/membership/claim`)).status).toBe(409)
    expect((await call('POST', '/api/provision/signup', { externalId: ext(), email: mail(), name: 'X', plan: 'member', claim: `${claim.body.claim.slice(0, -4)}AAAA` })).status).toBe(400)
    const row = (await ctx().db.select().from(workspacePlans).where(eq(workspacePlans.workspaceId, A.workspaceId)))[0]
    expect(row.email).toBe('whatever-they-typed@example.com')
    expect((await ctx().db.select().from(users).where(eq(users.email, 'whatever-they-typed@example.com'))).length).toBe(0)
  })
})
