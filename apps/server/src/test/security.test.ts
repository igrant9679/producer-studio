// Phase 0 hardening (evaluation of 25 Oct 2026): invites, upload types, body caps, headers, static files, abuse limits.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { setup, signup, type TestEnv } from './helpers'

// this file's own server: limits on, a proxy hop trusted, and a web build with a sibling folder next to it
const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-dist-'))
fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>app</title>')
fs.mkdirSync(path.join(webDist, 'assets'))
fs.writeFileSync(path.join(webDist, 'assets', 'index-abc.js'), 'console.log(1)')
fs.writeFileSync(path.join(webDist, 'assets', 'index-abc.js.map'), '{"sources":["secret.ts"]}')
fs.mkdirSync(`${webDist}-private`)
fs.writeFileSync(path.join(`${webDist}-private`, 'secret.txt'), 'top secret')
process.env.WEB_DIST = webDist
process.env.TRUST_PROXY_HOPS = '1'
process.env.SIGNUPS_PER_HOUR_PER_IP = '4'
process.env.DEVICES_PER_HOUR = '2'
process.env.QUEUED_JOBS_PER_WORKSPACE = '2'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

// every sign-up from a different client address, so the per-IP sign-up limit only bites where a test means it to
let ipN = 0
async function user(name = 'Test User') {
  const { Client } = await import('./helpers')
  const client = new Client(t.app)
  const email = `sec${Date.now()}${ipN}@example.com`
  const r = await client.req('POST', '/api/auth/signup', JSON.stringify({ email, password: 'correct-horse-1', name }), {
    'content-type': 'application/json',
    'x-forwarded-for': `10.1.${Math.floor(ipN / 250)}.${ipN++ % 250}`,
  })
  expect(r.status).toBe(200)
  const body = await r.json()
  return { client, email, workspaceId: body.workspaces[0].id as string }
}

async function team() {
  const A = await user('Owner')
  const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Team' })).body as { id: string }
  return { A, wsId: ws.id }
}

const tokenOf = (url: string) => url.split('/invite/')[1]

describe('invites', () => {
  it('only the invited address can accept, and only once', async () => {
    const { A, wsId } = await team()
    const B = await user('Invitee')
    const C = await user('Someone else')
    const inv = await A.client.json('POST', `/api/workspaces/${wsId}/invites`, { email: B.email.toUpperCase(), role: 'editor' })
    expect(inv.status).toBe(200)
    expect(inv.body.expiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000)
    const token = tokenOf(inv.body.inviteUrl)

    // someone holding the link but signed in as another account sees whose it is, and can't use it
    const seen = await C.client.json('GET', `/api/invites/${token}`)
    expect(seen.body).toMatchObject({ workspaceName: 'Team', role: 'editor', status: 'pending', forYou: false, member: false })
    const refused = await C.client.json('POST', `/api/invites/${token}/accept`)
    expect(refused.status).toBe(403)
    expect(refused.body.error).toContain(B.email)

    const ok = await B.client.json('POST', `/api/invites/${token}/accept`)
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ id: wsId, role: 'editor' })
    // the same person again is fine (a double click); the link is spent for everyone else
    expect((await B.client.json('POST', `/api/invites/${token}/accept`)).status).toBe(200)
    expect((await B.client.json('GET', `/api/invites/${token}`)).body).toMatchObject({ status: 'accepted', forYou: true, member: true })
    const members = (await A.client.json('GET', `/api/workspaces/${wsId}/members`)).body as unknown[]
    expect(members).toHaveLength(2)
  })

  it('two accepts at the same moment make one membership', async () => {
    const { A, wsId } = await team()
    const B = await user()
    const token = tokenOf((await A.client.json('POST', `/api/workspaces/${wsId}/invites`, { email: B.email, role: 'viewer' })).body.inviteUrl)
    const [r1, r2] = await Promise.all([B.client.json('POST', `/api/invites/${token}/accept`), B.client.json('POST', `/api/invites/${token}/accept`)])
    expect([r1.status, r2.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1)
    expect([r1.status, r2.status].every((s) => s === 200 || s === 409)).toBe(true)
    expect((await A.client.json('GET', `/api/workspaces/${wsId}/members`)).body).toHaveLength(2)
  })

  it('owners list and withdraw pending invites; a withdrawn or expired link stops working', async () => {
    const { A, wsId } = await team()
    const B = await user()
    const D = await user()
    const tB = tokenOf((await A.client.json('POST', `/api/workspaces/${wsId}/invites`, { email: B.email, role: 'editor' })).body.inviteUrl)
    const tD = tokenOf((await A.client.json('POST', `/api/workspaces/${wsId}/invites`, { email: D.email, role: 'viewer' })).body.inviteUrl)
    const list = (await A.client.json('GET', `/api/workspaces/${wsId}/invites`)).body as Array<{ token: string; email: string }>
    expect(list.map((i) => i.email).sort()).toEqual([B.email, D.email].sort())

    expect((await A.client.json('DELETE', `/api/workspaces/${wsId}/invites/${tB}`)).status).toBe(200)
    expect((await B.client.json('GET', `/api/invites/${tB}`)).body.status).toBe('revoked')
    expect((await B.client.json('POST', `/api/invites/${tB}/accept`)).status).toBe(410)

    const { ctx } = await import('../context')
    const { invites } = await import('../db/schema')
    await ctx().db.update(invites).set({ expiresAt: Date.now() - 1000 }).where(eq(invites.token, tD))
    expect((await D.client.json('GET', `/api/invites/${tD}`)).body.status).toBe('expired')
    expect((await D.client.json('POST', `/api/invites/${tD}/accept`)).status).toBe(410)
    expect((await A.client.json('GET', `/api/workspaces/${wsId}/invites`)).body).toEqual([])
  })

  it('only owners see or withdraw invites', async () => {
    const { A, wsId } = await team()
    const E = await user()
    const tE = tokenOf((await A.client.json('POST', `/api/workspaces/${wsId}/invites`, { email: E.email, role: 'editor' })).body.inviteUrl)
    await E.client.json('POST', `/api/invites/${tE}/accept`)
    expect((await E.client.json('GET', `/api/workspaces/${wsId}/invites`)).status).toBe(403)
    expect((await E.client.json('DELETE', `/api/workspaces/${wsId}/invites/${tE}`)).status).toBe(403)
  })

  it('an invite can raise an existing member, never lower one', async () => {
    const { A, wsId } = await team()
    const B = await user()
    const invite = async (role: string) => tokenOf((await A.client.json('POST', `/api/workspaces/${wsId}/invites`, { email: B.email, role })).body.inviteUrl)
    await B.client.json('POST', `/api/invites/${await invite('viewer')}/accept`)
    expect((await B.client.json('POST', `/api/invites/${await invite('editor')}/accept`)).body.role).toBe('editor')
    expect((await B.client.json('POST', `/api/invites/${await invite('viewer')}/accept`)).body.role).toBe('editor')
  })
})

describe('upload types', () => {
  it('refuses HTML and documents, and stores a media type for a media extension', async () => {
    const A = await user()
    const up = (filename: string, mime: string) => A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename, mime, size: 10 })
    expect((await up('clip.html', 'text/html')).status).toBe(415)
    expect((await up('notes.pdf', 'application/pdf')).status).toBe(415)
    expect((await up('page.htm', 'application/octet-stream')).status).toBe(200) // unknown: processing decides, served as a download
    const mp4 = await up('clip.mp4', 'text/html')
    expect(mp4.status).toBe(200)
    expect(mp4.body.headers['content-type']).toBe('video/mp4')
    expect((await up('old.avi', '')).body.headers['content-type']).toBe('video/x-msvideo')
  })

  it('serves a stored non-media type as a sandboxed download, never inline', async () => {
    const A = await user()
    const bytes = new TextEncoder().encode('<script>alert(document.cookie)</script>')
    const ticket = await A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'clip.mp4', mime: 'video/mp4', size: bytes.length })
    await A.client.req('PUT', ticket.body.url, bytes, { 'content-type': 'video/mp4' })
    // as an asset stored before uploads were checked would look
    const { ctx } = await import('../context')
    const { assets } = await import('../db/schema')
    await ctx().db.update(assets).set({ mime: 'text/html', status: 'ready' }).where(eq(assets.id, ticket.body.assetId))
    const res = await A.client.req('GET', `/api/media/${ticket.body.assetId}/source`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('keeps SVG logos drawable in <img> but never opens one as a page', async () => {
    const A = await user()
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const ticket = await A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'logo.svg', mime: 'image/svg+xml', size: bytes.length })
    expect(ticket.status).toBe(200)
    await A.client.req('PUT', ticket.body.url, bytes, { 'content-type': 'image/svg+xml' })
    await A.client.json('POST', `/api/assets/${ticket.body.assetId}/complete`)
    const res = await A.client.req('GET', `/api/media/${ticket.body.assetId}/source`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })
})

describe('request bodies, headers and static files', () => {
  it('refuses a huge sign-in body before reading it', async () => {
    const A = await user()
    const big = JSON.stringify({ email: 'x@example.com', password: 'y'.repeat(2 * 1024 * 1024) })
    const res = await A.client.req('POST', '/api/auth/login', big, { 'content-type': 'application/json' })
    expect(res.status).toBe(413)
    expect((await res.json()).code).toBe('quota')
  })

  it('sends security headers, and the public health check names no storage error', async () => {
    const res = await t.app.request('/api/health')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    const body = await res.json()
    expect(body).toHaveProperty('storageStatus')
    expect(body).not.toHaveProperty('storageError')
  })

  it('serves the app but not its source maps, sibling folders or bad escapes', async () => {
    expect(await (await t.app.request('/assets/index-abc.js')).text()).toBe('console.log(1)')
    expect((await t.app.request('/assets/index-abc.js.map')).status).toBe(404)
    const sibling = await t.app.request(`/..%2f${path.basename(webDist)}-private%2fsecret.txt`)
    expect(await sibling.text()).not.toContain('top secret')
    expect((await t.app.request('/%E0%A4%A')).status).toBe(400)
    expect(await (await t.app.request('/edit/some-project')).text()).toContain('<title>app</title>')
  })
})

describe('abuse limits', () => {
  it('limits sign-ups per client address, using the proxy-appended hop', async () => {
    const { Client } = await import('./helpers')
    const attempt = (n: number, spoof: string) =>
      new Client(t.app).req('POST', '/api/auth/signup', JSON.stringify({ email: `burst${Date.now()}${n}@example.com`, password: 'correct-horse-1', name: 'Burst' }), {
        'content-type': 'application/json',
        // a client-chosen first entry, then the address our proxy saw
        'x-forwarded-for': `${spoof}, 192.0.2.77`,
      })
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await attempt(i, `203.0.113.${i}`)).status)
    expect(statuses).toEqual([200, 200, 200, 200, 429, 429])
  })

  it('a rotating X-Forwarded-For does not reset the sign-in throttle', async () => {
    const A = await user()
    const login = (spoof: string) => A.client.req('POST', '/api/auth/login', JSON.stringify({ email: A.email, password: 'wrong-password' }), { 'content-type': 'application/json', 'x-forwarded-for': `${spoof}, 198.51.100.9` })
    for (let i = 0; i < 8; i++) expect((await login(`10.9.9.${i}`)).status).toBe(401)
    expect((await login('10.9.9.200')).status).toBe(429)
  })

  it('caps device tokens per hour', async () => {
    const A = await user()
    const mk = () => A.client.json('POST', '/api/devices', { name: 'Laptop' })
    expect((await mk()).status).toBe(200)
    expect((await mk()).status).toBe(200)
    expect((await mk()).status).toBe(429)
  })

  it('caps slow work waiting in one workspace', async () => {
    const A = await user()
    const tts = () => A.client.json('POST', '/api/ai/tts', { workspaceId: A.workspaceId, text: 'Hello there', voice: 'af_heart' })
    expect((await tts()).status).toBe(200)
    expect((await tts()).status).toBe(200)
    const third = await tts()
    expect(third.status).toBe(429)
    expect(third.body.error).toMatch(/already has 2/)
  })
})
