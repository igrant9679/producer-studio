import { beforeAll, describe, expect, it } from 'vitest'
import { Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

const DEFAULTS = { theme: 'system', textSize: 'md', accent: 'coral', density: 'comfortable', reduceMotion: false }

describe('appearance preferences', () => {
  it('requires a session', async () => {
    const anon = new Client(t.app)
    expect((await anon.json('GET', '/api/me/preferences')).status).toBe(401)
    expect((await anon.json('PUT', '/api/me/preferences', { theme: 'dark' })).status).toBe(401)
  })

  it('returns the defaults until the user saves', async () => {
    const { client } = await signup(t.app)
    const r = await client.json('GET', '/api/me/preferences')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ preferences: DEFAULTS, updatedAt: null })
  })

  it('merges partial updates and keeps the other fields', async () => {
    const { client } = await signup(t.app)
    const a = await client.json('PUT', '/api/me/preferences', { theme: 'light', accent: 'teal' })
    expect(a.status).toBe(200)
    expect(a.body.preferences).toEqual({ ...DEFAULTS, theme: 'light', accent: 'teal' })
    expect(typeof a.body.updatedAt).toBe('number')

    const b = await client.json('PUT', '/api/me/preferences', { textSize: 'xl', density: 'compact', reduceMotion: true })
    expect(b.body.preferences).toEqual({ theme: 'light', textSize: 'xl', accent: 'teal', density: 'compact', reduceMotion: true })
    expect(b.body.updatedAt).toBeGreaterThanOrEqual(a.body.updatedAt)

    const got = await client.json('GET', '/api/me/preferences')
    expect(got.body).toEqual(b.body)

    // an empty patch is a no-op save
    const c = await client.json('PUT', '/api/me/preferences', {})
    expect(c.status).toBe(200)
    expect(c.body.preferences).toEqual(b.body.preferences)
  })

  it('rejects invalid values and unknown keys', async () => {
    const { client } = await signup(t.app)
    for (const bad of [{ theme: 'sepia' }, { textSize: 'xxl' }, { accent: '#ff0000' }, { density: 'cozy' }, { reduceMotion: 'yes' }, { fontFamily: 'Comic Sans' }]) {
      const r = await client.json('PUT', '/api/me/preferences', bad)
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect(r.body.code).toBe('invalid')
    }
    expect((await client.json('PUT', '/api/me/preferences', ['dark'])).status).toBe(400)
    // nothing was stored
    expect((await client.json('GET', '/api/me/preferences')).body).toEqual({ preferences: DEFAULTS, updatedAt: null })
  })

  it('keeps each user’s preferences separate', async () => {
    const alice = await signup(t.app, 'Alice')
    const bob = await signup(t.app, 'Bob')
    await alice.client.json('PUT', '/api/me/preferences', { theme: 'dark', accent: 'pink' })
    await bob.client.json('PUT', '/api/me/preferences', { theme: 'light', textSize: 'sm' })
    expect((await alice.client.json('GET', '/api/me/preferences')).body.preferences).toEqual({ ...DEFAULTS, theme: 'dark', accent: 'pink' })
    expect((await bob.client.json('GET', '/api/me/preferences')).body.preferences).toEqual({ ...DEFAULTS, theme: 'light', textSize: 'sm' })
    const carol = await signup(t.app, 'Carol')
    expect((await carol.client.json('GET', '/api/me/preferences')).body.updatedAt).toBeNull()
  })
})
