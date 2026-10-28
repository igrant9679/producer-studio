// Voice Studio (A-20): the space's pronunciation dictionary and the script markup reach every voice made in it (pauses
// as real silence, emphasis slower and louder), each person keeps a draft and favourite voices per space, and a line
// previews in a voice without being saved. Kokoro is replaced by a short tone; ffmpeg joins the parts for real.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { VoiceSettings, VoiceStudioPrefs } from '@producer/core'
import { synthesizeToAsset } from '../ai/speech'
import { tts } from '../ai/tts'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { setup, signup, type TestEnv } from './helpers'

let t: TestEnv
const spoken: Array<{ text: string; speed: number }> = []
beforeAll(async () => {
  t = await setup()
  vi.spyOn(tts, 'synthesize').mockImplementation(async (text, out, opts) => {
    spoken.push({ text, speed: opts.speed })
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=24000', '-t', '0.5', out])
    return { duration: 0.5, sampleRate: 24000 }
  })
})
afterEach(() => {
  spoken.length = 0
})

async function team() {
  const A = await signup(t.app, 'Owner')
  const V = await signup(t.app, 'Viewer')
  const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Voice team' })).body as { id: string }
  const inv = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: V.email, role: 'viewer' })
  await V.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
  const userId = (await A.client.json('GET', '/api/auth/me')).body.user.id as string
  return { A, V, wsId: ws.id, userId }
}

describe('Voice Studio', () => {
  it('keeps a pronunciation dictionary per space (editors change it), one entry per word', async () => {
    const { A, V, wsId } = await team()
    const url = `/api/workspaces/${wsId}/voice-settings`
    expect((await V.client.json<VoiceSettings>('GET', url)).body).toEqual({ pronunciations: [] })
    expect((await V.client.json('PUT', url, { pronunciations: [{ word: 'SQL', say: 'sequel' }] })).status).toBe(403)
    const r = await A.client.json<VoiceSettings>('PUT', url, { pronunciations: [{ word: 'SQL', say: 'ess-cue-ell' }, { word: 'Acme', say: 'Ack-me' }, { word: 'sql', say: 'sequel' }] })
    expect(r.body.pronunciations).toEqual([{ word: 'sql', say: 'sequel' }, { word: 'Acme', say: 'Ack-me' }])
    expect((await A.client.json('PUT', url, { pronunciations: [{ word: '', say: 'x' }] })).status).toBe(400)
  })

  it('voices a script with the dictionary, real pauses and emphasis; the asset keeps the script as written', async () => {
    const { A, wsId, userId } = await team()
    await A.client.json('PUT', `/api/workspaces/${wsId}/voice-settings`, { pronunciations: [{ word: 'Acme', say: 'Ack-me' }] })
    const text = 'Welcome to Acme. [pause 1.5s] This is *really* big.'
    const jc = inlineContext({ id: 'vs-test', kind: 'ai.tts', workspaceId: wsId, userId, projectId: null, input: {} })
    const r = await synthesizeToAsset({ workspaceId: wsId, userId, text, voice: 'af_heart', speed: 1 }, jc)
    expect(spoken).toEqual([
      { text: 'Welcome to Ack-me.', speed: 1 },
      { text: 'This is', speed: 1 },
      { text: 'really', speed: 0.88 },
      { text: 'big.', speed: 1 },
    ])
    // four half-second parts and the pause, joined
    expect(r.duration).toBeGreaterThan(3.3)
    expect(r.duration).toBeLessThan(3.8)
    expect(r.row.meta?.tts?.text).toBe(text)

    // a plain script is still one call, with the dictionary applied
    spoken.length = 0
    await synthesizeToAsset({ workspaceId: wsId, userId, text: 'Acme makes videos', voice: 'af_heart' }, jc)
    expect(spoken).toEqual([{ text: 'Ack-me makes videos', speed: 1 }])
  })

  it('keeps each person’s draft and favourite voices per space', async () => {
    const { A, V, wsId } = await team()
    const url = `/api/workspaces/${wsId}/voice-studio`
    expect((await A.client.json<VoiceStudioPrefs>('GET', url)).body).toEqual({ favourites: [] })
    const saved = await A.client.json<VoiceStudioPrefs>('PUT', url, { draft: { text: 'Hello team', name: 'Intro', speed: 1.1, voice: 'am_eric' }, favourites: ['am_eric', 'af_heart', 'am_eric'] })
    expect(saved.body).toEqual({ draft: { text: 'Hello team', name: 'Intro', speed: 1.1, voice: 'am_eric' }, favourites: ['am_eric', 'af_heart'] })
    // favourites alone leave the draft as it is; a viewer has their own
    expect((await A.client.json<VoiceStudioPrefs>('PUT', url, { favourites: ['af_heart'] })).body.draft?.text).toBe('Hello team')
    expect((await V.client.json<VoiceStudioPrefs>('GET', url)).body).toEqual({ favourites: [] })
    expect((await V.client.json('PUT', url, { favourites: ['bf_emma'] })).status).toBe(200)
    // another space of A's starts empty
    expect((await A.client.json<VoiceStudioPrefs>('GET', `/api/workspaces/${A.workspaceId}/voice-studio`)).body).toEqual({ favourites: [] })
    expect((await A.client.json<VoiceStudioPrefs>('PUT', url, { draft: null })).body).toEqual({ favourites: ['af_heart'] })
  })

  it('previews a line in a built-in voice as audio, without saving it', async () => {
    const { A, V, wsId } = await team()
    const url = `/api/workspaces/${wsId}/voice-preview`
    const res = await A.client.req('POST', url, { text: 'A quick [pause] test', voice: 'am_eric' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/wav')
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000)
    expect(spoken.map((s) => s.text)).toEqual(['A quick', 'test'])
    expect((await A.client.json('POST', url, { text: 'x', voice: 'vs:abc' })).status).toBe(400)
    expect((await A.client.json('POST', url, { text: 'x'.repeat(301), voice: 'am_eric' })).status).toBe(400)
    expect((await V.client.json('POST', url, { text: 'x', voice: 'am_eric' })).status).toBe(403)
    const assets = (await A.client.json('GET', `/api/assets?workspaceId=${wsId}`)).body
    expect((Array.isArray(assets) ? assets : assets.items).length).toBe(0)
  })
})
