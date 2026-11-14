// Sharing a space's AI keys with other spaces (cloud): only an owner of both spaces can; the receiving space uses the
// key through a pointer and never sees it; replacing, removing and unsharing reach it at once. Fake SDK clients.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import OpenAI from 'openai'
import { auditSentence } from '@producer/core'
import { ctx } from '../context'
import { aiKeyShares, aiKeys, auditLog } from '../db/schema'
import { setKeyClients } from '../ai/keys'
import { resolveProvider } from '../ai/resolve'
import { keyMeta, readKey, writeKey } from '../ai/store'
import { auditDto } from '../services/audit'
import { type Client, setup, signup, type TestEnv } from './helpers'

const KEY = 'sk-proj-SHAREKEY0123456789abcdefQRST'
const KEY2 = 'sk-proj-SECONDKEY0123456789abcdUVWX'
const BAD_KEY = 'sk-proj-INVALIDINVALIDINVALID9999'
const FAL_KEY = 'fal-id-0123:secret-4567-MNOP'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
  setKeyClients({
    openai: (key) => ({
      responses: {
        async create() {
          return (async function* () {
            yield { type: 'response.output_text.delta', delta: 'From OpenAI' } as never
            yield { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'From OpenAI' }] }] } } as never
          })()
        },
      },
      models: {
        async *list() {
          if (key === BAD_KEY) throw OpenAI.APIError.generate(401, { error: { message: `Incorrect API key provided: ${key}` } }, undefined, new Headers())
          yield* [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }]
        },
      },
    }),
  })
})
afterAll(() => setKeyClients(undefined))

const noKeys = (body: unknown) => {
  const s = JSON.stringify(body)
  for (const k of [KEY, KEY2, BAD_KEY, FAL_KEY]) expect(s).not.toContain(k)
  expect(s).not.toMatch(/ciphertext|"iv"|"tag"/)
}

type Person = { client: Client; workspaceId: string; email: string }

async function newSpace(p: Person, name: string): Promise<string> {
  const r = await p.client.json('POST', '/api/workspaces', { name })
  expect(r.status).toBe(200)
  return r.body.id
}

async function invite(owner: Person, workspaceId: string, role: 'owner' | 'editor' | 'viewer'): Promise<Person> {
  const m = await signup(t.app, role)
  const inv = await owner.client.json('POST', `/api/workspaces/${workspaceId}/invites`, { email: m.email, role })
  expect(inv.status).toBe(200)
  const token = inv.body.inviteUrl.split('/invite/')[1]
  expect((await m.client.json('POST', `/api/invites/${token}/accept`)).status).toBe(200)
  return m
}

const settings = async (p: Person, ws: string) => (await p.client.json('GET', `/api/ai/settings?workspaceId=${ws}`)).body
const share = (p: Person, from: string, to: string, provider = 'openai') => p.client.json('PUT', `/api/ai/keys/${provider}/shares/${to}`, { workspaceId: from })

/** An owner with an OpenAI key in their own space and a second space they own. */
async function ownerOfTwo(name: string) {
  const A = await signup(t.app, name)
  const put = await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: A.workspaceId, key: KEY })
  expect(put.body.ok).toBe(true)
  const other = await newSpace(A, `${name} client`)
  return { A, home: A.workspaceId, other }
}

describe('sharing an AI key with another space', () => {
  it('an owner of both spaces shares a key: the other space uses it without holding or seeing it', async () => {
    const { A, home, other } = await ownerOfTwo('Sharer')
    // before: the second space has no AI
    expect((await settings(A, other)).providers.openai).toBeUndefined()
    expect(await readKey(other, 'openai')).toBeUndefined()

    const r = await share(A, home, other)
    expect(r.status).toBe(200)
    expect(r.body.providers.openai).toMatchObject({ hasKey: true, keyLast4: 'QRST', sharedWith: [{ workspaceId: other, name: 'Sharer client' }] })
    expect(r.body.providers.openai.shared).toBeUndefined()
    noKeys(r.body)

    const theirs = await settings(A, other)
    expect(theirs.providers.openai).toMatchObject({ hasKey: true, valid: true, model: 'gpt-5.5', models: ['gpt-5.5', 'gpt-5.5-mini'], shared: { workspaceId: home } })
    // not this space's key: no last four characters, and nothing it could share on
    expect(theirs.providers.openai.keyLast4).toBeUndefined()
    expect(theirs.providers.openai.sharedWith).toBeUndefined()
    // a space with no AI at all starts using the shared key
    expect(theirs.defaultProvider).toBe('openai')
    expect(theirs.effective.writer).toEqual({ provider: 'openai', model: 'gpt-5.5' })
    noKeys(theirs)

    // a pointer, never a copy
    expect(await ctx().db.select().from(aiKeys).where(eq(aiKeys.workspaceId, other))).toHaveLength(0)
    expect(await readKey(other, 'openai')).toBe(KEY)
    expect((await keyMeta(other)).openai).toMatchObject({ sharedFrom: home })
    expect((await resolveProvider(other, 'writer')).provider.id).toBe('openai')
    const res = await A.client.req('POST', '/api/ai/write', { kind: 'headline', prompt: 'x', workspaceId: other })
    expect(await res.text()).toContain('From OpenAI')
    const sys = await A.client.json('GET', `/api/system?workspaceId=${other}`)
    expect(sys.body.ai).toMatchObject({ provider: 'openai', available: true })
    noKeys(sys.body)

    // sharing again changes nothing; the receiving space keeps its own choice of model
    await A.client.json('PUT', '/api/ai/settings', { workspaceId: other, models: { openai: 'gpt-5.5-mini' } })
    expect((await share(A, home, other)).status).toBe(200)
    expect(await ctx().db.select().from(aiKeyShares).where(eq(aiKeyShares.toWorkspaceId, other))).toHaveLength(1)
    expect((await settings(A, other)).providers.openai.model).toBe('gpt-5.5-mini')
    expect((await settings(A, home)).providers.openai.model).toBe('gpt-5.5')
  })

  it('only owners can share, and only with a space they own', async () => {
    const { A, home, other } = await ownerOfTwo('Gate')
    const editor = await invite(A, home, 'editor')
    const viewer = await invite(A, home, 'viewer')
    // an editor or viewer of the sharing space can't share its key, even with a space of their own
    for (const m of [editor, viewer]) {
      const r = await share(m, home, m.workspaceId)
      expect(r).toMatchObject({ status: 403, body: { error: 'Only workspace owners can manage AI keys and settings' } })
    }
    // an owner can't push a key into a space they aren't in (it doesn't exist as far as they can tell) ...
    const stranger = await signup(t.app, 'Stranger')
    expect((await share(A, home, stranger.workspaceId)).status).toBe(404)
    // ... or one they are in without owning it
    const guest = await invite(stranger, stranger.workspaceId, 'editor')
    const guestKey = await guest.client.json('PUT', '/api/ai/keys/openai', { workspaceId: guest.workspaceId, key: KEY2 })
    expect(guestKey.body.ok).toBe(true)
    expect(await share(guest, guest.workspaceId, stranger.workspaceId)).toMatchObject({ status: 403, body: { error: 'You can only share a key with a space you own' } })
    // someone outside the sharing space can't share or unshare its key
    expect((await share(stranger, home, stranger.workspaceId)).status).toBe(404)
    expect((await share(A, home, other)).status).toBe(200)
    expect((await stranger.client.json('DELETE', `/api/ai/keys/openai/shares/${other}?workspaceId=${home}`)).status).toBe(404)
    expect((await editor.client.json('DELETE', `/api/ai/keys/openai/shares/${other}?workspaceId=${home}`)).status).toBe(403)
    expect(await readKey(other, 'openai')).toBe(KEY)
    // members who aren't owners see that a key is set up, never where it is shared
    const seen = await settings(editor, home)
    expect(seen.canEdit).toBe(false)
    expect(seen.providers.openai.hasKey).toBe(true)
    expect(seen.providers.openai.sharedWith).toBeUndefined()
    // a member of the receiving space sees whose key it uses, and can't stop it unless they own the space
    const member = await invite(A, other, 'editor')
    expect((await settings(member, other)).providers.openai).toMatchObject({ hasKey: true, shared: { workspaceId: home, name: expect.any(String) } })
    expect((await member.client.json('DELETE', `/api/ai/keys/openai?workspaceId=${other}`)).status).toBe(403)
    expect(await readKey(other, 'openai')).toBe(KEY)
  })

  it('refuses what makes no sense: itself, no key, a key that is only shared here, a space with its own key', async () => {
    const { A, home, other } = await ownerOfTwo('Edge')
    expect((await share(A, home, home)).status).toBe(400)
    expect(await share(A, home, other, 'gemini')).toMatchObject({ status: 409, body: { error: 'Add a Gemini key to this space before sharing it' } })
    expect((await share(A, home, other, 'mistral')).status).toBe(400)
    expect((await share(A, home, other)).status).toBe(200)
    // a shared key isn't passed on
    const third = await newSpace(A, 'Edge third')
    expect(await share(A, other, third)).toMatchObject({ status: 409, body: { error: /can’t pass it on/ } })
    expect(await readKey(third, 'openai')).toBeUndefined()
    // a space with a key of its own keeps it
    await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: third, key: KEY2 })
    expect(await share(A, home, third)).toMatchObject({ status: 409, body: { error: '“Edge third” has its own OpenAI key. Remove it there first.' } })
    expect(await readKey(third, 'openai')).toBe(KEY2)
    // unsharing something that isn't shared
    expect((await A.client.json('DELETE', `/api/ai/keys/openai/shares/${third}?workspaceId=${home}`)).status).toBe(404)
  })

  it('replacing the key reaches the spaces that use it, with its test result', async () => {
    const { A, home, other } = await ownerOfTwo('Rotate')
    await share(A, home, other)
    const bad = await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: home, key: BAD_KEY })
    expect(bad.body.ok).toBe(false)
    expect(bad.body.settings.providers.openai.sharedWith).toHaveLength(1)
    expect(await readKey(other, 'openai')).toBe(BAD_KEY)
    const theirs = await settings(A, other)
    expect(theirs.providers.openai).toMatchObject({ hasKey: true, valid: false, shared: { workspaceId: home } })
    const w = await A.client.json('POST', '/api/ai/write', { kind: 'headline', prompt: 'x', workspaceId: other })
    expect(w).toMatchObject({ status: 503, body: { error: /OpenAI API key was rejected/ } })
    noKeys(theirs)

    await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: home, key: KEY2 })
    expect(await readKey(other, 'openai')).toBe(KEY2)
    expect((await settings(A, other)).providers.openai).toMatchObject({ valid: true, shared: { workspaceId: home } })
    // the receiving space's owner can test the key it uses; the result is recorded there
    const test = await A.client.json('POST', '/api/ai/keys/openai/test', { workspaceId: other })
    expect(test.body).toMatchObject({ ok: true })
    noKeys(test.body)
  })

  it('unsharing, stopping its use, a key of its own, and removing the key all end the share', async () => {
    const { A, home, other } = await ownerOfTwo('Ends')
    const second = await newSpace(A, 'Ends second')

    // the sharing space stops sharing
    await share(A, home, other)
    const un = await A.client.json('DELETE', `/api/ai/keys/openai/shares/${other}?workspaceId=${home}`)
    expect(un.status).toBe(200)
    expect(un.body.providers.openai.sharedWith).toBeUndefined()
    expect(await readKey(other, 'openai')).toBeUndefined()
    let theirs = await settings(A, other)
    expect(theirs.providers.openai?.hasKey ?? false).toBe(false)
    expect(theirs.defaultProvider).toBeNull()
    expect((await resolveProvider(other, 'writer')).choice).toBe('builtin')

    // the receiving space stops using it: the key itself stays where it is
    await share(A, home, other)
    const stop = await A.client.json('DELETE', `/api/ai/keys/openai?workspaceId=${other}`)
    expect(stop.status).toBe(200)
    expect(stop.body.providers.openai?.hasKey ?? false).toBe(false)
    expect(await readKey(other, 'openai')).toBeUndefined()
    expect(await readKey(home, 'openai')).toBe(KEY)
    expect((await settings(A, home)).providers.openai.sharedWith).toBeUndefined()

    // a key of its own replaces the shared one
    await share(A, home, other)
    const own = await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: other, key: KEY2 })
    expect(own.body.settings.providers.openai).toMatchObject({ hasKey: true, keyLast4: 'UVWX' })
    expect(own.body.settings.providers.openai.shared).toBeUndefined()
    expect(await readKey(other, 'openai')).toBe(KEY2)
    expect(await ctx().db.select().from(aiKeyShares).where(eq(aiKeyShares.fromWorkspaceId, home))).toHaveLength(0)
    await A.client.json('DELETE', `/api/ai/keys/openai?workspaceId=${other}`)
    // ... and removing that own key doesn't bring the shared one back
    expect(await readKey(other, 'openai')).toBeUndefined()

    // removing the key ends every share of it
    await share(A, home, other)
    await share(A, home, second)
    expect((await settings(A, home)).providers.openai.sharedWith).toHaveLength(2)
    expect((await A.client.json('DELETE', `/api/ai/keys/openai?workspaceId=${home}`)).status).toBe(200)
    expect(await ctx().db.select().from(aiKeyShares).where(eq(aiKeyShares.fromWorkspaceId, home))).toHaveLength(0)
    for (const ws of [other, second]) {
      expect(await readKey(ws, 'openai')).toBeUndefined()
      theirs = await settings(A, ws)
      expect(theirs.providers.openai?.hasKey ?? false).toBe(false)
      expect(theirs.defaultProvider).toBeNull()
    }
  })

  it('media keys are shared the same way', async () => {
    const { A, home, other } = await ownerOfTwo('Media')
    await writeKey(home, 'fal', FAL_KEY)
    const r = await share(A, home, other, 'fal')
    expect(r.status).toBe(200)
    expect(r.body.media.fal).toMatchObject({ hasKey: true, keyLast4: 'MNOP', sharedWith: [{ workspaceId: other }] })
    const theirs = await settings(A, other)
    expect(theirs.media.fal).toMatchObject({ hasKey: true, shared: { workspaceId: home } })
    expect(theirs.media.fal.keyLast4).toBeUndefined()
    // a media key never becomes the writing provider
    expect(theirs.defaultProvider).toBeNull()
    expect(await readKey(other, 'fal')).toBe(FAL_KEY)
    noKeys(theirs)
    expect((await A.client.json('DELETE', `/api/ai/keys/fal/shares/${other}?workspaceId=${home}`)).status).toBe(200)
    expect(await readKey(other, 'fal')).toBeUndefined()
    expect((await settings(A, other)).media.fal).toBeUndefined()
  })

  it('both spaces get an audit entry, in words', async () => {
    const { A, home, other } = await ownerOfTwo('Audit')
    await share(A, home, other)
    await A.client.json('DELETE', `/api/ai/keys/openai/shares/${other}?workspaceId=${home}`)
    const rows = async (ws: string) =>
      (await ctx().db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws))))
        .filter((r) => r.kind.startsWith('ai.key.') && r.kind !== 'ai.key.set')
        .sort((a, b) => a.at - b.at)
        .map((r) => auditSentence(auditDto(r)))
    const mine = await rows(home)
    expect(mine).toHaveLength(2)
    expect(mine[0]).toMatch(/shared the openai AI key with “Audit client”$/)
    expect(mine[1]).toMatch(/stopped sharing the openai AI key with “Audit client”$/)
    const theirs = await rows(other)
    expect(theirs).toHaveLength(2)
    expect(theirs[0]).toMatch(/set this space to use the openai AI key of “/)
    expect(theirs[1]).toMatch(/stopped this space using the openai AI key of “/)
    noKeys(await ctx().db.select().from(auditLog).where(eq(auditLog.workspaceId, home)))
  })
})
