// Cloud side of VoiceStudio voices: synced profile metadata pushed by a desktop, the voices list, and the
// cloud → desktop relay (TTS with a profile voice becomes a `voice.relay` job only the owning device can claim).
import { beforeAll, describe, expect, it } from 'vitest'
import { Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

function bearer(token: string) {
  const c = new Client(t.app)
  return {
    json: async <T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> => {
      const res = await c.req(method, url, body, { authorization: `Bearer ${token}` })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : undefined }
    },
  }
}

const consent = { statement: 'I am the speaker and agree to this voice being cloned.', attestedBy: 'u', attestedAt: 1, speaker: 'me' }

async function withDevice(name = 'Studio PC') {
  const A = await signup(t.app, 'Voice Owner')
  const d = await A.client.json('POST', '/api/devices', { name })
  expect(d.status).toBe(200)
  return { ...A, dev: bearer(d.body.token), deviceId: d.body.deviceId as string }
}

async function pushVoice(dev: ReturnType<typeof bearer>, workspaceId: string, id = `vp_${Math.random().toString(36).slice(2, 12)}`, patch: Record<string, unknown> = {}) {
  const r = await dev.json('PUT', `/api/voice/profiles/${id}`, { workspaceId, name: 'My voice', kind: 'clone', engine: 'omnivoice', language: 'English', consent, createdAt: 1000, updatedAt: 2000, ...patch })
  expect(r.status).toBe(200)
  return r.body
}

describe('voice profiles (cloud)', () => {
  it('a desktop pushes a profile; it lists for members and appears in the voices list', async () => {
    const A = await withDevice()
    const v = await pushVoice(A.dev, A.workspaceId)
    expect(v).toMatchObject({ name: 'My voice', kind: 'clone', engine: 'omnivoice', deviceId: A.deviceId, local: false })
    const list = await A.client.json('GET', `/api/voice/profiles?workspaceId=${A.workspaceId}`)
    expect(list.body.map((x: { id: string }) => x.id)).toEqual([v.id])
    const voices = await A.client.json('GET', `/api/ai/voices?workspaceId=${A.workspaceId}`)
    const mine = voices.body.find((x: { id: string }) => x.id === `vs:${v.id}`)
    // the device just talked to the cloud, so it counts as online
    expect(mine).toMatchObject({ name: 'My voice', source: 'clone', engine: 'omnivoice', available: true, detail: 'Generated on Studio PC' })
    expect(voices.body.find((x: { id: string }) => x.id === 'af_heart')).toBeTruthy()
  })

  it('only devices push; cookies are refused; older pushes never overwrite newer edits', async () => {
    const A = await withDevice()
    expect((await A.client.json('PUT', '/api/voice/profiles/vp_cookie123', { workspaceId: A.workspaceId, name: 'x', kind: 'clone', engine: '', consent, createdAt: 1, updatedAt: 1 })).status).toBe(403)
    const v = await pushVoice(A.dev, A.workspaceId)
    const renamed = await A.client.json('PATCH', `/api/voice/profiles/${v.id}`, { name: 'Renamed on web' })
    expect(renamed.body.name).toBe('Renamed on web')
    const stale = await pushVoice(A.dev, A.workspaceId, v.id, { name: 'Old desktop copy', updatedAt: 2500 })
    expect(stale.name).toBe('Renamed on web')
  })

  it('outsiders can’t see or push into a space', async () => {
    const A = await withDevice()
    const B = await withDevice('Other PC')
    expect((await B.client.json('GET', `/api/voice/profiles?workspaceId=${A.workspaceId}`)).status).toBe(404)
    expect((await B.dev.json('PUT', '/api/voice/profiles/vp_intruder1', { workspaceId: A.workspaceId, name: 'x', kind: 'clone', engine: '', consent, createdAt: 1, updatedAt: 1 })).status).toBe(404)
  })

  it('profile changes and deletes flow through the sync feed', async () => {
    const A = await withDevice()
    const c0 = (await A.client.json('GET', '/api/sync/changes?since=0&limit=500')).body.cursor
    const v = await pushVoice(A.dev, A.workspaceId)
    const ch1 = await A.client.json('GET', `/api/sync/changes?since=${c0}`)
    expect(ch1.body.voiceProfiles.map((x: { id: string }) => x.id)).toEqual([v.id])
    expect((await A.client.json('DELETE', `/api/voice/profiles/${v.id}`)).body).toEqual({ ok: true })
    const ch2 = await A.client.json('GET', `/api/sync/changes?since=${ch1.body.cursor}`)
    expect(ch2.body.deleted.voiceProfiles).toEqual([v.id])
  })
})

describe('voice relay', () => {
  it('TTS with a profile voice queues a relay job that only the owning device can claim and finish', async () => {
    const A = await withDevice()
    const other = bearer((await A.client.json('POST', '/api/devices', { name: 'Laptop' })).body.token)
    const v = await pushVoice(A.dev, A.workspaceId)
    const job = await A.client.json('POST', '/api/ai/tts', { workspaceId: A.workspaceId, text: 'Hello from the web', voice: `vs:${v.id}` })
    expect(job.status).toBe(200)
    expect(job.body).toMatchObject({ kind: 'voice.relay', status: 'queued', message: 'Waiting for Studio PC' })
    // the cloud worker never picks it up
    await new Promise((r) => setTimeout(r, 1200))
    expect((await A.client.json('GET', `/api/jobs/${job.body.id}`)).body.status).toBe('queued')

    expect((await other.json('GET', '/api/voice/relay/claim')).body).toEqual({ job: null })
    expect((await A.client.json('GET', '/api/voice/relay/claim')).status).toBe(403)
    const claim = await A.dev.json('GET', '/api/voice/relay/claim')
    expect(claim.body.job).toMatchObject({ id: job.body.id, status: 'running', input: { profileId: v.id, text: 'Hello from the web', deviceId: A.deviceId } })
    expect((await other.json('POST', `/api/voice/relay/${job.body.id}/progress`, { progress: 0.5 })).status).toBe(403)
    expect((await A.dev.json('POST', `/api/voice/relay/${job.body.id}/progress`, { progress: 0.5, message: 'Generating' })).body).toEqual({ ok: true, cancelled: false })
    // done needs the uploaded asset
    expect((await A.dev.json('POST', `/api/voice/relay/${job.body.id}/done`, { assetId: 'as_missing' })).status).toBe(409)
    const failed = await A.dev.json('POST', `/api/voice/relay/${job.body.id}/fail`, { error: 'GPU on fire' })
    expect(failed.body).toMatchObject({ status: 'error', error: 'GPU on fire' })
  })

  it('cancelling a relay job tells the desktop on its next heartbeat', async () => {
    const A = await withDevice()
    const v = await pushVoice(A.dev, A.workspaceId)
    const job = await A.client.json('POST', '/api/ai/tts', { workspaceId: A.workspaceId, text: 'Cancel me', voice: `vs:${v.id}` })
    await A.dev.json('GET', '/api/voice/relay/claim')
    await A.client.json('POST', `/api/jobs/${job.body.id}/cancel`)
    expect((await A.dev.json('POST', `/api/voice/relay/${job.body.id}/progress`, { progress: 0.2 })).body.cancelled).toBe(true)
  })

  it('refuses voices from another space or from a device that was revoked', async () => {
    const A = await withDevice()
    const B = await withDevice('B PC')
    const v = await pushVoice(A.dev, A.workspaceId)
    expect((await B.client.json('POST', '/api/ai/tts', { workspaceId: B.workspaceId, text: 'x', voice: `vs:${v.id}` })).status).toBe(404)
    await A.client.json('DELETE', `/api/devices/${A.deviceId}`)
    const r = await A.client.json('POST', '/api/ai/tts', { workspaceId: A.workspaceId, text: 'x', voice: `vs:${v.id}` })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/no longer linked/)
  })
})
