// Sign-up through the membership website (the owner, 28 Nov 2026: "Send them to meyousocial.com"): with APP_SIGNUP
// 'website' (the production default) the app makes an account only for an invited address, so a member can still bring
// in their team; everyone else is pointed at the membership page. 'open' signs anyone up, as before.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})
afterEach(() => {
  ctx().config.appSignup = 'open'
})

const newPerson = (email: string) => new Client(t.app).json<{ error?: string; details?: { membershipUrl?: string }; user?: { email: string } }>('POST', '/api/auth/signup', { email, password: 'correct-horse-1', name: 'New Person' })

describe('sign-up through the website', () => {
  it('says how people get an account here (public)', async () => {
    const anon = new Client(t.app)
    expect((await anon.json('GET', '/api/auth/options')).body).toEqual({ signup: 'open', membershipUrl: ctx().config.membershipUrl })
    ctx().config.appSignup = 'website'
    expect((await anon.json<{ signup: string }>('GET', '/api/auth/options')).body.signup).toBe('website')
  })

  it('refuses a new account with no invitation, saying where to join', async () => {
    ctx().config.appSignup = 'website'
    const r = await newPerson(`stranger${Date.now()}@example.com`)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/come with a MeYouSocial membership: join at https?:\/\//)
    expect(r.body.details?.membershipUrl).toBe(ctx().config.membershipUrl)
  })

  it('an invited address still makes its account, and joins the space', async () => {
    const owner = await signup(t.app, 'Space Owner')
    const email = `teammate${Date.now()}@example.com`
    const inv = await owner.client.json<{ inviteUrl: string }>('POST', `/api/workspaces/${owner.workspaceId}/invites`, { email, role: 'editor' })
    expect(inv.status).toBe(200)
    const token = inv.body.inviteUrl.split('/invite/')[1]
    ctx().config.appSignup = 'website'
    const c = new Client(t.app)
    const made = await c.json<{ user: { email: string } }>('POST', '/api/auth/signup', { email: email.toUpperCase(), password: 'correct-horse-1', name: 'Team Mate' })
    expect(made.status).toBe(200)
    expect(made.body.user.email).toBe(email)
    const accepted = await c.json('POST', `/api/invites/${token}/accept`)
    expect(accepted.status).toBe(200)
    // a withdrawn invitation doesn't count
    const gone = `withdrawn${Date.now()}@example.com`
    const inv2 = await owner.client.json<{ inviteUrl: string }>('POST', `/api/workspaces/${owner.workspaceId}/invites`, { email: gone, role: 'viewer' })
    await owner.client.json('DELETE', `/api/workspaces/${owner.workspaceId}/invites/${inv2.body.inviteUrl.split('/invite/')[1]}`)
    expect((await newPerson(gone)).status).toBe(403)
  })

  it('open again (APP_SIGNUP=open): anyone signs up', async () => {
    ctx().config.appSignup = 'open'
    expect((await newPerson(`anyone${Date.now()}@example.com`)).status).toBe(200)
  })
})
