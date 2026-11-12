// AI video clips with Wan on fal.ai: the media-only key (stored, tested against fal's free price list, never a writing
// provider), who makes clips when Gemini could too, the queue flow (submit, poll, download, cancel, time out), the
// fallback to Wan 2.7 when fal stops hosting Wan 2.2, and plain errors that never carry the key. Fake fetch and clock.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiSettings } from '@producer/core'
import { setKeyClients } from '../ai/keys'
import { generateVideo, generationCapabilities } from '../ai/generate'
import { type MediaInfo, setGenerateClients } from '../ai/generate/capabilities'
import { pricePerSecond } from '../ai/generate/fal'
import { firstFramePrompt, makeAiClip } from '../ai/produce'
import { CancelledError } from '../jobs/worker'
import { setup, signup, type TestEnv } from './helpers'

const FAL_KEY = '3f1c2a9e-7b4d-4e21-9c55-0a1b2c3d4e5f:0123456789abcdef0123456789abcdef'
const GEMINI_KEY = 'AIzaSyFALTEST0123456789abcdefghij'
const WAN22 = 'fal-ai/wan/v2.2-a14b/text-to-video'
const WAN27 = 'fal-ai/wan/v2.7/text-to-video'
const CDN = 'https://v3.fal.media/files/zebra/clip.mp4'
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(32, 3)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 9)])
const WAN22_I2V = 'fal-ai/wan/v2.2-a14b/image-to-video'
const WAN27_I2V = 'fal-ai/wan/v2.7/image-to-video'
/** Gemini's image model (a picture painted first); clips never go to Gemini in these tests. */
const geminiImage = vi.fn()

interface Call {
  method: string
  url: string
  auth?: string
  body?: Record<string, unknown>
}
type Handler = (c: Call) => Response | Promise<Response>

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const calls: Call[] = []
let handler: Handler
let probeResult: (file: string) => Promise<MediaInfo>
let clock = 0
const sleeps: number[] = []

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  const c: Call = {
    method: init?.method ?? 'GET',
    url: String(input),
    ...(headers.get('authorization') ? { auth: headers.get('authorization')! } : {}),
    ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
  }
  calls.push(c)
  return handler(c)
})

/** fal's price list: the key test. */
const pricing = (c: Call, rows = [{ endpoint_id: WAN22, unit_price: 0.08, unit: 'second', currency: 'USD' }]) =>
  c.url.startsWith('https://api.fal.ai/v1/models/pricing') ? (c.auth === `Key ${FAL_KEY}` ? json(200, { prices: rows, next_cursor: null, has_more: false }) : json(401, { error: { type: 'authorization_error', message: 'Authentication required' } })) : undefined

const base = (m: string, id = 'req-1') => `https://queue.fal.run/${m}/requests/${id}`
const queued = (m = WAN22, extra: Record<string, unknown> = {}) => ({ request_id: 'req-1', status: 'IN_QUEUE', queue_position: 2, status_url: `${base(m)}/status`, response_url: base(m), cancel_url: `${base(m)}/cancel`, ...extra })

/** A fal queue that answers `statuses` in turn, then the result and the clip. */
function queue(statuses: Array<Record<string, unknown>>, opts: { model?: string; result?: Response; submit?: Response } = {}): Handler {
  const m = opts.model ?? WAN22
  let i = 0
  return (c) => {
    const p = pricing(c)
    if (p) return p
    if (c.method === 'POST' && c.url === `https://queue.fal.run/${m}`) return opts.submit ?? json(200, queued(m))
    if (c.method === 'GET' && c.url.startsWith(`${base(m)}/status`)) return json(200, statuses[Math.min(i++, statuses.length - 1)])
    if (c.method === 'GET' && c.url === base(m)) return opts.result ?? json(200, { video: { url: CDN, content_type: 'video/mp4' }, seed: 7 })
    if (c.method === 'PUT' && c.url === `${base(m)}/cancel`) return json(200, { success: true })
    if (c.url === CDN) return new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) } })
    return json(404, { detail: `Application not found: ${c.url}` })
  }
}

let t: TestEnv
let outDir: string
beforeAll(async () => {
  t = await setup()
  outDir = path.join(t.dataDir, 'generated-fal')
  setKeyClients({
    gemini: () => ({
      models: {
        generateContentStream: async () => (async function* () {})(),
        list: async () => (async function* () {
          yield { name: 'models/gemini-3-pro', supportedActions: ['generateContent'] }
        })(),
      },
    }),
  })
})
afterAll(() => {
  setKeyClients(undefined)
  setGenerateClients(undefined)
})

beforeEach(() => {
  calls.length = 0
  sleeps.length = 0
  clock = 5_000_000
  handler = (c) => pricing(c) ?? json(404, {})
  probeResult = async () => ({ duration: 8.06, width: 1280, height: 720 })
  geminiImage.mockReset()
  geminiImage.mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] }, finishReason: 'STOP' }] })
  setGenerateClients({
    gemini: () =>
      ({
        models: { generateContent: geminiImage },
        interactions: {
          create: async () => {
            throw new Error('no Gemini clips here')
          },
          get: async () => {
            throw new Error('no Gemini clips here')
          },
          cancel: async () => undefined,
        },
      }) as never,
    fetch: fetchMock as unknown as typeof fetch,
    probe: (file) => probeResult(file),
    now: () => clock,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new CancelledError()
      sleeps.push(ms)
      clock += ms
    },
  })
})

async function space(keys: { fal?: string; gemini?: string; videoProvider?: 'gemini' | 'fal' } = {}) {
  const A = await signup(t.app, 'Clip maker')
  if (keys.gemini) expect((await A.client.json('PUT', '/api/ai/keys/gemini', { workspaceId: A.workspaceId, key: keys.gemini })).status).toBe(200)
  if (keys.fal) expect((await A.client.json('PUT', '/api/ai/keys/fal', { workspaceId: A.workspaceId, key: keys.fal })).status).toBe(200)
  if (keys.videoProvider) expect((await A.client.json('PUT', '/api/ai/settings', { workspaceId: A.workspaceId, videoProvider: keys.videoProvider })).status).toBe(200)
  return A
}

async function failure(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  const err = (await p.then(
    () => {
      throw new Error('expected a failure')
    },
    (e: unknown) => e,
  )) as { status: number; message: string }
  expect(err.message).not.toContain(FAL_KEY)
  expect(err.message).not.toContain(FAL_KEY.split(':')[1])
  return err
}

describe('the fal.ai key', () => {
  it('is stored, tested against fal’s price list (free), shown with the price, and never becomes a writing provider', async () => {
    const A = await signup(t.app, 'Owner')
    const r = await A.client.json('PUT', '/api/ai/keys/fal', { workspaceId: A.workspaceId, key: FAL_KEY })
    expect(r.status).toBe(200)
    const body = r.body as { ok: boolean; detail: string; price?: string; settings: AiSettings }
    expect(body).toMatchObject({ ok: true, detail: '✓ valid · Wan 2.2: $0.08 per second of video', price: 'Wan 2.2: $0.08 per second of video' })
    expect(JSON.stringify(body)).not.toContain(FAL_KEY)
    expect(body.settings.media?.fal).toMatchObject({ hasKey: true, keyLast4: FAL_KEY.slice(-4), valid: true, price: 'Wan 2.2: $0.08 per second of video' })
    expect(body.settings.providers).toEqual({})
    expect(body.settings.defaultProvider).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'GET', auth: `Key ${FAL_KEY}` })
    expect(decodeURIComponent(calls[0].url)).toBe(`https://api.fal.ai/v1/models/pricing?endpoint_id=${WAN22},${WAN27}`)
    // the stored key can be tested again, and removed
    const again = (await A.client.json('POST', '/api/ai/keys/fal/test', { workspaceId: A.workspaceId })).body as { ok: boolean }
    expect(again.ok).toBe(true)
    const removed = (await A.client.json('DELETE', `/api/ai/keys/fal?workspaceId=${A.workspaceId}`)).body as AiSettings
    expect(removed.media?.fal).toBeUndefined()
  })

  it('a key fal rejects is stored as failing, with a plain reason, and isn’t used for clips', async () => {
    const A = await signup(t.app, 'Owner')
    const body = (await A.client.json('PUT', '/api/ai/keys/fal', { workspaceId: A.workspaceId, key: 'wrong-key-000:abc' })).body as { ok: boolean; detail: string; settings: AiSettings }
    expect(body).toMatchObject({ ok: false, detail: 'fal.ai didn’t accept this key. Copy it again from fal.ai → API keys.' })
    expect(body.settings.media?.fal).toMatchObject({ hasKey: true, valid: false })
    expect((await generationCapabilities(A.workspaceId)).video).toBeUndefined()
    const err = await failure(generateVideo({ workspaceId: A.workspaceId, prompt: 'waves', aspect: '16:9', seconds: 8, outDir }))
    expect(err).toMatchObject({ status: 503, message: 'fal.ai didn’t accept this key. Copy it again from fal.ai → API keys.' })
  })

  it('when fal no longer lists a Wan model, the key is still checked (against a model it certainly lists)', async () => {
    const A = await signup(t.app, 'Owner')
    handler = (c) => (c.url.includes(encodeURIComponent(WAN22)) ? json(404, { error: { type: 'not_found', message: 'Endpoint not found' } }) : pricing(c, [{ endpoint_id: 'fal-ai/flux/dev', unit_price: 0.025, unit: 'image', currency: 'USD' }])!)
    const body = (await A.client.json('PUT', '/api/ai/keys/fal', { workspaceId: A.workspaceId, key: FAL_KEY })).body as { ok: boolean; detail: string }
    expect(body).toMatchObject({ ok: true, detail: '✓ valid' })
    expect(calls.map((c) => decodeURIComponent(c.url.split('endpoint_id=')[1]))).toEqual([`${WAN22},${WAN27}`, 'fal-ai/flux/dev'])
  })
})

describe('who makes clips', () => {
  it('fal alone: Wan 2.2, up to 10 s', async () => {
    const A = await space({ fal: FAL_KEY })
    expect((await generationCapabilities(A.workspaceId)).video).toEqual({ provider: 'fal', model: WAN22, maxSeconds: 10, pricePerSecond: 0.08 })
    expect((await generationCapabilities(A.workspaceId)).image).toBeUndefined()
  })

  it('both keys: Gemini unless the space chose Wan; the choice needs the key and is dropped with it', async () => {
    const A = await space({ fal: FAL_KEY, gemini: GEMINI_KEY })
    expect((await generationCapabilities(A.workspaceId)).video?.provider).toBe('gemini')
    const chosen = (await A.client.json('PUT', '/api/ai/settings', { workspaceId: A.workspaceId, videoProvider: 'fal' })).body as AiSettings
    expect(chosen.videoProvider).toBe('fal')
    expect((await generationCapabilities(A.workspaceId)).video?.provider).toBe('fal')
    const after = (await A.client.json('DELETE', `/api/ai/keys/fal?workspaceId=${A.workspaceId}`)).body as AiSettings
    expect(after.videoProvider).toBeNull()
    expect((await generationCapabilities(A.workspaceId)).video?.provider).toBe('gemini')
    expect((await A.client.json('PUT', '/api/ai/settings', { workspaceId: A.workspaceId, videoProvider: 'fal' })).status).toBe(400)
    expect((await A.client.json('PUT', '/api/ai/settings', { workspaceId: A.workspaceId, videoProvider: 'sora' })).status).toBe(400)
  })

  it('a chosen fal key that fails its test hands clips to Gemini', async () => {
    const A = await space({ fal: FAL_KEY, gemini: GEMINI_KEY, videoProvider: 'fal' })
    handler = () => json(401, { error: { type: 'authorization_error', message: 'Authentication required' } })
    expect((await A.client.json('POST', '/api/ai/keys/fal/test', { workspaceId: A.workspaceId })).body as { ok: boolean }).toMatchObject({ ok: false })
    expect((await generationCapabilities(A.workspaceId)).video?.provider).toBe('gemini')
  })

  it('without a clip key, the message names both providers', async () => {
    const A = await space()
    expect((await failure(generateVideo({ workspaceId: A.workspaceId, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))).message).toBe(
      'AI video clips need your own Gemini or fal.ai API key. Add one in Settings → AI.',
    )
  })
})

describe('a Wan clip', () => {
  it('is queued with the key, polled with backoff, downloaded from the CDN without the key, and written', async () => {
    const A = await space({ fal: FAL_KEY })
    calls.length = 0
    handler = queue([
      { status: 'IN_QUEUE', queue_position: 1 },
      { status: 'IN_PROGRESS' },
      { status: 'IN_PROGRESS' },
      { status: 'COMPLETED' },
    ])
    const progress: Array<[number, string]> = []
    const r = await generateVideo({ workspaceId: A.workspaceId, prompt: 'a lighthouse at dusk, slow push in', aspect: '9:16', seconds: 8, outDir, onProgress: (f, m) => progress.push([f, m]) })
    expect(r).toMatchObject({ mime: 'video/mp4', provider: 'fal', model: WAN22, seconds: 8.06, width: 1280, height: 720 })
    expect(fs.readFileSync(r.file).equals(MP4)).toBe(true)
    const submit = calls[0]
    expect(submit).toMatchObject({ method: 'POST', url: `https://queue.fal.run/${WAN22}`, auth: `Key ${FAL_KEY}` })
    expect(submit.body).toMatchObject({
      prompt: 'a lighthouse at dusk, slow push in',
      aspect_ratio: '9:16',
      resolution: '720p',
      num_frames: 129,
      frames_per_second: 16,
      enable_prompt_expansion: false,
      enable_safety_checker: true,
    })
    expect(String(submit.body?.negative_prompt)).toMatch(/watermark/)
    // the key goes to fal's queue only, never to the CDN
    const cdn = calls.filter((c) => c.url === CDN)
    expect(cdn).toHaveLength(1)
    expect(cdn[0].auth).toBeUndefined()
    expect(calls.filter((c) => c.url !== CDN).every((c) => c.auth === `Key ${FAL_KEY}` && c.url.startsWith('https://queue.fal.run/'))).toBe(true)
    expect(sleeps).toEqual([5000, 7500, 11250, 16875])
    expect(progress[0]).toEqual([0, 'Starting the AI clip'])
    expect(progress[1][1]).toBe('Waiting in fal.ai’s queue (1 ahead)')
    expect(progress.some(([, m]) => m === 'Generating the clip')).toBe(true)
    expect(progress.at(-1)).toEqual([1, 'Clip ready'])
    const fractions = progress.map(([f]) => f)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('clamps the length to Wan 2.2’s 161 frames, and 1:1 is passed through', async () => {
    const A = await space({ fal: FAL_KEY })
    calls.length = 0
    handler = queue([{ status: 'COMPLETED' }])
    await generateVideo({ workspaceId: A.workspaceId, prompt: 'a spark', aspect: '1:1', seconds: 30, outDir })
    expect(calls[0].body).toMatchObject({ num_frames: 161, aspect_ratio: '1:1' })
    calls.length = 0
    await generateVideo({ workspaceId: A.workspaceId, prompt: 'a spark', aspect: '16:9', seconds: 0.4, outDir })
    expect(calls[0].body).toMatchObject({ num_frames: 33 })
  })

  it('URLs fal hands back on other hosts are not followed with the key', async () => {
    const A = await space({ fal: FAL_KEY })
    calls.length = 0
    const inner = queue([{ status: 'COMPLETED' }])
    handler = (c) => (c.method === 'POST' ? json(200, queued(WAN22, { status_url: 'https://evil.example/steal', response_url: 'http://queue.fal.run/insecure' })) : inner(c))
    await generateVideo({ workspaceId: A.workspaceId, prompt: 'waves', aspect: '16:9', seconds: 5, outDir })
    expect(calls.some((c) => c.url.includes('evil.example') || c.url.startsWith('http://'))).toBe(false)
    expect(calls.map((c) => c.url)).toContain(`${base(WAN22)}/status?logs=0`)
    expect(calls.map((c) => c.url)).toContain(base(WAN22))
  })

  it('when fal no longer hosts Wan 2.2 (404), Wan 2.7 makes the clip in whole seconds at 720p', async () => {
    const A = await space({ fal: FAL_KEY })
    calls.length = 0
    const wan27 = queue([{ status: 'COMPLETED' }], { model: WAN27 })
    handler = (c) => (c.url === `https://queue.fal.run/${WAN22}` ? json(404, { detail: 'Application not found' }) : wan27(c))
    const r = await generateVideo({ workspaceId: A.workspaceId, prompt: 'waves', aspect: '16:9', seconds: 12.4, outDir })
    expect(r.model).toBe(WAN27)
    const submit = calls.find((c) => c.url === `https://queue.fal.run/${WAN27}`)
    expect(submit?.body).toMatchObject({ duration: 12, resolution: '720p', aspect_ratio: '16:9', enable_prompt_expansion: false })
    // remembered: the next clip goes straight to Wan 2.7, and capabilities says so
    expect((await generationCapabilities(A.workspaceId)).video).toEqual({ provider: 'fal', model: WAN27, maxSeconds: 15 })
  })

  it('a fired signal cancels the queued request', async () => {
    const A = await space({ fal: FAL_KEY })
    calls.length = 0
    const ac = new AbortController()
    const inner = queue([{ status: 'IN_PROGRESS' }])
    let polls = 0
    handler = (c) => {
      if (c.url.includes('/status') && ++polls === 2) ac.abort()
      return inner(c)
    }
    await expect(generateVideo({ workspaceId: A.workspaceId, prompt: 'waves', aspect: '16:9', seconds: 8, outDir, signal: ac.signal })).rejects.toBeInstanceOf(CancelledError)
    expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.url, c.auth])).toEqual([[`${base(WAN22)}/cancel`, `Key ${FAL_KEY}`]])
  })

  it('gives up after 15 minutes and cancels', async () => {
    const A = await space({ fal: FAL_KEY })
    calls.length = 0
    handler = queue([{ status: 'IN_PROGRESS' }])
    const start = clock
    const err = await failure(generateVideo({ workspaceId: A.workspaceId, prompt: 'waves', aspect: '16:9', seconds: 8, outDir }))
    expect(err).toMatchObject({ status: 504, message: expect.stringContaining('wasn’t ready after 15 minutes') })
    expect(clock - start).toBe(15 * 60_000)
    expect(calls.some((c) => c.method === 'PUT' && c.url === `${base(WAN22)}/cancel`)).toBe(true)
  })

  it('rides out a few failed status checks', async () => {
    const A = await space({ fal: FAL_KEY })
    const inner = queue([{ status: 'COMPLETED' }])
    let n = 0
    handler = (c) => {
      if (c.url.includes('/status') && n++ < 2) {
        if (n === 1) throw new TypeError('fetch failed')
        return json(503, { detail: 'Service unavailable' })
      }
      return inner(c)
    }
    expect((await generateVideo({ workspaceId: A.workspaceId, prompt: 'waves', aspect: '16:9', seconds: 8, outDir })).provider).toBe('fal')
  })

  it('fal’s content rules, an empty balance, a rejected key and outages read plainly', async () => {
    const A = await space({ fal: FAL_KEY })
    handler = queue([{ status: 'COMPLETED' }], { result: json(422, { detail: [{ loc: ['body', 'prompt'], msg: 'The content could not be processed because it contained material flagged by a content checker.', type: 'content_policy_violation' }] }) })
    expect(await failure(generateVideo({ workspaceId: A.workspaceId, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))).toMatchObject({
      status: 422,
      message: 'fal.ai declined to make this clip (Wan’s content rules). Try describing the scene differently.',
    })
    handler = queue([], { submit: json(403, { detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' }) })
    expect(await failure(generateVideo({ workspaceId: A.workspaceId, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))).toMatchObject({ status: 429, message: expect.stringContaining('out of credit') })
    handler = queue([], { submit: json(401, { detail: `Invalid key ${FAL_KEY}` }) })
    expect(await failure(generateVideo({ workspaceId: A.workspaceId, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))).toMatchObject({ status: 503, message: expect.stringContaining('didn’t accept this space’s key') })
    handler = queue([], { submit: json(500, { detail: 'boom' }) })
    expect(await failure(generateVideo({ workspaceId: A.workspaceId, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))).toMatchObject({ status: 502 })
    handler = queue([{ status: 'COMPLETED', error: `GPU worker crashed for ${FAL_KEY}`, error_type: 'runner_error' }])
    expect(await failure(generateVideo({ workspaceId: A.workspaceId, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))).toMatchObject({ status: 502, message: expect.stringContaining('[redacted]') })
  })
})

describe('picture first: Wan animates a picture painted first', () => {
  it('reads the price a second off fal’s price list', () => {
    expect(pricePerSecond('Wan 2.2: $0.08 per second of video')).toBe(0.08)
    expect(pricePerSecond('$0.1 per second of video')).toBe(0.1)
    expect(pricePerSecond('$0.4 per clip')).toBeUndefined()
    expect(pricePerSecond(undefined)).toBeUndefined()
  })

  it('is offered when the space can paint a picture as well as make a Wan clip', async () => {
    const A = await space({ fal: FAL_KEY, gemini: GEMINI_KEY, videoProvider: 'fal' })
    expect((await generationCapabilities(A.workspaceId)).video).toEqual({ provider: 'fal', model: WAN22, maxSeconds: 10, fromPicture: true, pricePerSecond: 0.08 })
    // Gemini making the clips: words alone
    const B = await space({ fal: FAL_KEY, gemini: GEMINI_KEY })
    expect((await generationCapabilities(B.workspaceId)).video?.fromPicture).toBeUndefined()
  })

  it('paints the opening frame, then sends it to Wan’s image-to-video as a data URI', async () => {
    const A = await space({ fal: FAL_KEY, gemini: GEMINI_KEY, videoProvider: 'fal' })
    calls.length = 0
    handler = queue([{ status: 'COMPLETED' }], { model: WAN22_I2V })
    const progress: string[] = []
    const r = await makeAiClip({ workspaceId: A.workspaceId, prompt: 'a fox runs through snow, camera tracking', aspect: '16:9', seconds: 6, outDir, fromPicture: true, signal: new AbortController().signal, progress: (_f, m) => progress.push(m) })
    expect(r).toMatchObject({ provider: 'fal', model: WAN22_I2V, fromPicture: true })
    expect(geminiImage).toHaveBeenCalledTimes(1)
    const painted = geminiImage.mock.calls[0][0] as { contents: Array<{ parts: Array<{ text: string }> }>; config: { imageConfig: { aspectRatio: string } } }
    expect(painted.contents[0].parts[0].text).toBe(firstFramePrompt('a fox runs through snow, camera tracking'))
    expect(painted.config.imageConfig.aspectRatio).toBe('16:9')
    const submit = calls.find((c) => c.method === 'POST')!
    expect(submit.url).toBe(`https://queue.fal.run/${WAN22_I2V}`)
    expect(submit.body).toMatchObject({ prompt: 'a fox runs through snow, camera tracking', aspect_ratio: '16:9', resolution: '720p', num_frames: 97, image_url: `data:image/png;base64,${PNG.toString('base64')}` })
    expect(progress[0]).toBe('Painting the first frame')
  })

  it('when fal stops hosting Wan 2.2, Wan 2.7 animates the picture (whole seconds, its aspect from the picture)', async () => {
    const A = await space({ fal: FAL_KEY, gemini: GEMINI_KEY, videoProvider: 'fal' })
    const next = queue([{ status: 'COMPLETED' }], { model: WAN27_I2V })
    handler = (c) => (c.method === 'POST' && c.url === `https://queue.fal.run/${WAN22_I2V}` ? json(404, { detail: 'Application not found' }) : next(c))
    const r = await makeAiClip({ workspaceId: A.workspaceId, prompt: 'waves', aspect: '9:16', seconds: 12.4, outDir, fromPicture: true, signal: new AbortController().signal, progress: () => undefined })
    expect(r.model).toBe(WAN27_I2V)
    const body = calls.find((c) => c.method === 'POST' && c.url.endsWith(WAN27_I2V))!.body!
    expect(body).toMatchObject({ duration: 12, resolution: '720p' })
    expect(body.image_url).toMatch(/^data:image\/png;base64,/)
    expect(body.aspect_ratio).toBeUndefined()
  })

  it('a picture that can’t be painted (refused) leaves the clip to the words alone', async () => {
    const A = await space({ fal: FAL_KEY, gemini: GEMINI_KEY, videoProvider: 'fal' })
    geminiImage.mockResolvedValue({ promptFeedback: { blockReason: 'SAFETY' } })
    handler = queue([{ status: 'COMPLETED' }])
    const r = await makeAiClip({ workspaceId: A.workspaceId, prompt: 'x', aspect: '16:9', seconds: 5, outDir, fromPicture: true, signal: new AbortController().signal, progress: () => undefined })
    expect(r).toMatchObject({ model: WAN22 })
    expect(r.fromPicture).toBeUndefined()
    expect(calls.find((c) => c.method === 'POST')!.body?.image_url).toBeUndefined()
  })

  it('without picture-first, no picture is painted', async () => {
    const A = await space({ fal: FAL_KEY, gemini: GEMINI_KEY, videoProvider: 'fal' })
    handler = queue([{ status: 'COMPLETED' }])
    await makeAiClip({ workspaceId: A.workspaceId, prompt: 'x', aspect: '16:9', seconds: 5, outDir, signal: new AbortController().signal, progress: () => undefined })
    expect(geminiImage).not.toHaveBeenCalled()
  })
})
