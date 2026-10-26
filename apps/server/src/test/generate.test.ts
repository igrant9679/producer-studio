// Media generation for videos made without recordings: which key and model a workspace gets (capabilities), AI stills
// per provider with model fallback, AI clips (polling, cancel, timeout), Pexels stock search/download, and clean errors
// that never carry key material. Fake SDK clients, fetch, ffprobe and clock: no network.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import OpenAI from 'openai'
import { ApiError } from '@google/genai'
import { ctx } from '../context'
import { aiKeys } from '../db/schema'
import { setKeyClients } from '../ai/keys'
import { downloadStock, generateImage, generateVideo, generationCapabilities, searchStock, type StockClip } from '../ai/generate'
import { type GenInteraction, type MediaInfo, setGenerateClients } from '../ai/generate/capabilities'
import { CancelledError } from '../jobs/worker'
import { setup, signup, type TestEnv } from './helpers'

const OPENAI_KEY = 'sk-proj-GENKEY0123456789abcdefWXYZ'
const GEMINI_KEY = 'AIzaSyGENKEY0123456789abcdefgh'
const BAD_KEY = 'sk-proj-REJECTEDREJECTEDREJECT0000'
const PEXELS_KEY = 'pexels-test-key-0123456789'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)])
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(32, 7)])

const openAiError = (status: number, error: Record<string, unknown>) => OpenAI.APIError.generate(status, { error }, undefined, new Headers())
const geminiError = (status: number, message: string) => new ApiError({ status, message: JSON.stringify({ error: { code: status, message } }) })

// ---------------- fakes ----------------

const keysSeen: string[] = []
const openai = { generate: vi.fn() }
const gemini = { generateContent: vi.fn(), create: vi.fn(), get: vi.fn(), cancel: vi.fn(), delete: vi.fn() }
const fetchMock = vi.fn()
let probeResult: (file: string) => Promise<MediaInfo>
let clock = 0
const sleeps: number[] = []

let t: TestEnv
let outDir: string
beforeAll(async () => {
  delete process.env.PEXELS_API_KEY
  t = await setup()
  outDir = path.join(t.dataDir, 'generated')
  // key validation on PUT /api/ai/keys/* (the text providers' model list)
  setKeyClients({
    openai: (key) => ({
      responses: { create: async () => (async function* () {})() },
      models: {
        async *list() {
          if (key === BAD_KEY) throw openAiError(401, { message: `Incorrect API key provided: ${key}` })
          yield* [{ id: 'gpt-5.5' }]
        },
      },
    }),
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
  for (const f of [openai.generate, ...Object.values(gemini), fetchMock]) f.mockReset()
  gemini.cancel.mockResolvedValue({})
  gemini.delete.mockResolvedValue(undefined)
  keysSeen.length = 0
  sleeps.length = 0
  clock = 1_000_000
  probeResult = async () => ({ width: 1536, height: 864 })
  ctx().config.pexelsApiKey = undefined
  // also clears the model memo, so every test starts from the first candidate
  setGenerateClients({
    openai: (key) => {
      keysSeen.push(key)
      return { images: { generate: openai.generate } }
    },
    gemini: (key) => {
      keysSeen.push(key)
      return {
        models: { generateContent: gemini.generateContent },
        interactions: { create: gemini.create, get: gemini.get, cancel: gemini.cancel, delete: gemini.delete },
      }
    },
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

/** A workspace with the given keys stored through the settings API (and optionally a default provider). */
async function space(keys: { openai?: string; gemini?: string; defaultProvider?: 'openai' | 'gemini' } = {}) {
  const A = await signup(t.app, 'Maker')
  if (keys.openai) expect((await A.client.json('PUT', '/api/ai/keys/openai', { workspaceId: A.workspaceId, key: keys.openai })).status).toBe(200)
  if (keys.gemini) expect((await A.client.json('PUT', '/api/ai/keys/gemini', { workspaceId: A.workspaceId, key: keys.gemini })).status).toBe(200)
  if (keys.defaultProvider) expect((await A.client.json('PUT', '/api/ai/settings', { workspaceId: A.workspaceId, defaultProvider: keys.defaultProvider })).status).toBe(200)
  return A.workspaceId
}

/** Rejects with an HttpError-like value; checks no key material is in its message. */
async function failure(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  const err = (await p.then(
    () => {
      throw new Error('expected a failure')
    },
    (e: unknown) => e,
  )) as { status: number; message: string }
  for (const k of [OPENAI_KEY, GEMINI_KEY, BAD_KEY, PEXELS_KEY]) expect(err.message).not.toContain(k)
  return err
}

const imageOk = (b64 = JPEG.toString('base64')) => ({ created: 1, data: [{ b64_json: b64 }], output_format: 'jpeg' })
const geminiImageOk = (data = PNG) => ({ candidates: [{ content: { parts: [{ text: 'Here you go' }, { inlineData: { mimeType: 'image/png', data: data.toString('base64') } }] }, finishReason: 'STOP' }] })
const running = (status = 'in_progress'): GenInteraction => ({ id: 'int-1', status })
const done = (): GenInteraction => ({ id: 'int-1', status: 'completed', output_video: { data: MP4.toString('base64'), mime_type: 'video/mp4' } })

// ---------------- capabilities ----------------

describe('generationCapabilities', () => {
  it('nothing without keys; stock only with the server’s Pexels key', async () => {
    const ws = await space()
    expect(await generationCapabilities(ws)).toEqual({ stock: false })
    ctx().config.pexelsApiKey = PEXELS_KEY
    expect(await generationCapabilities(ws)).toEqual({ stock: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an OpenAI key makes stills (no clips: Sora is gone)', async () => {
    const ws = await space({ openai: OPENAI_KEY })
    expect(await generationCapabilities(ws)).toEqual({ image: { provider: 'openai', model: 'gpt-image-2.5-flare' }, stock: false })
  })

  it('a Gemini key makes stills and clips', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    expect(await generationCapabilities(ws)).toEqual({
      image: { provider: 'gemini', model: 'gemini-nano-banana-2.1' },
      video: { provider: 'gemini', model: 'gemini-omni-1.1-flash', maxSeconds: 10 },
      stock: false,
    })
  })

  it('with both keys the default provider makes the stills', async () => {
    const both = await space({ openai: OPENAI_KEY, gemini: GEMINI_KEY })
    expect((await generationCapabilities(both)).image).toEqual({ provider: 'openai', model: 'gpt-image-2.5-flare' })
    const geminiFirst = await space({ openai: OPENAI_KEY, gemini: GEMINI_KEY, defaultProvider: 'gemini' })
    const caps = await generationCapabilities(geminiFirst)
    expect(caps.image).toEqual({ provider: 'gemini', model: 'gemini-nano-banana-2.1' })
    expect(caps.video?.provider).toBe('gemini')
    // no network to answer this
    expect(openai.generate).not.toHaveBeenCalled()
    expect(gemini.generateContent).not.toHaveBeenCalled()
  })

  it('a rejected key is passed over for a working one, and explains itself when it is the only one', async () => {
    // OpenAI is even the default here: its failed key still isn't used while the Gemini key works
    const ws = await space({ openai: BAD_KEY, gemini: GEMINI_KEY, defaultProvider: 'openai' })
    expect((await generationCapabilities(ws)).image?.provider).toBe('gemini')
    const only = await space({ openai: BAD_KEY })
    expect(await generationCapabilities(only)).toEqual({ stock: false })
    const err = await failure(generateImage({ workspaceId: only, prompt: 'a lighthouse', aspect: '16:9', outDir }))
    expect(err).toMatchObject({ status: 503, message: 'The OpenAI API key was rejected. Check or replace it in Settings → AI.' })
  })

  it("a saved key that can't be decrypted stops with a reason (no fallback)", async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    await ctx().db.update(aiKeys).set({ tag: Buffer.alloc(16).toString('base64') }).where(and(eq(aiKeys.workspaceId, ws), eq(aiKeys.provider, 'gemini')))
    expect(await generationCapabilities(ws)).toEqual({ stock: false })
    const err = await failure(generateVideo({ workspaceId: ws, prompt: 'waves', aspect: '16:9', seconds: 8, outDir }))
    expect(err.status).toBe(503)
    expect(err.message).toMatch(/enter it again in Settings → AI/)
    expect(gemini.create).not.toHaveBeenCalled()
  })
})

// ---------------- stills ----------------

describe('generateImage', () => {
  it('no key → 503 telling people to add one in Settings → AI', async () => {
    const ws = await space()
    const err = await failure(generateImage({ workspaceId: ws, prompt: 'a red bicycle', aspect: '16:9', outDir }))
    expect(err).toMatchObject({ status: 503, message: 'AI images need your own OpenAI or Gemini API key. Add one in Settings → AI.' })
  })

  it('OpenAI: GPT Image with the workspace key, 16:9 → 1536×864, JPEG written to outDir', async () => {
    const ws = await space({ openai: OPENAI_KEY })
    openai.generate.mockResolvedValue(imageOk())
    const ac = new AbortController()
    const r = await generateImage({ workspaceId: ws, prompt: '  a red bicycle at dawn ', aspect: '16:9', outDir, signal: ac.signal })
    expect(r).toMatchObject({ mime: 'image/jpeg', provider: 'openai', model: 'gpt-image-2.5-flare', width: 1536, height: 864 })
    expect(path.dirname(r.file)).toBe(outDir)
    expect(r.file.endsWith('.jpg')).toBe(true)
    expect(fs.readFileSync(r.file).equals(JPEG)).toBe(true)
    expect(keysSeen).toEqual([OPENAI_KEY])
    expect(openai.generate).toHaveBeenCalledWith(
      { model: 'gpt-image-2.5-flare', prompt: 'a red bicycle at dawn', n: 1, size: '1536x864', quality: 'medium', output_format: 'jpeg', output_compression: 90 },
      { signal: ac.signal },
    )
    await generateImage({ workspaceId: ws, prompt: 'portrait', aspect: '9:16', outDir })
    expect(openai.generate.mock.calls[1][0].size).toBe('864x1536')
  })

  it('OpenAI: a model the key can’t use (404) falls through to the next, which capabilities then reports', async () => {
    const ws = await space({ openai: OPENAI_KEY })
    openai.generate.mockImplementation(async (body: { model: string }) => {
      if (body.model === 'gpt-image-2.5-flare') throw openAiError(404, { message: 'The model `gpt-image-2.5-flare` does not exist or you do not have access to it.', code: 'model_not_found' })
      return imageOk()
    })
    const r = await generateImage({ workspaceId: ws, prompt: 'a red bicycle', aspect: '1:1', outDir })
    expect(r.model).toBe('gpt-image-2')
    expect(openai.generate.mock.calls.map((c) => [c[0].model, c[0].size])).toEqual([
      ['gpt-image-2.5-flare', '1024x1024'],
      ['gpt-image-2', '1024x1024'],
    ])
    expect((await generationCapabilities(ws)).image).toEqual({ provider: 'openai', model: 'gpt-image-2' })
    // the dead model is skipped next time (no second 404)
    await generateImage({ workspaceId: ws, prompt: 'again', aspect: '16:9', outDir })
    expect(openai.generate.mock.calls.slice(2).map((c) => c[0].model)).toEqual(['gpt-image-2'])
  })

  it('OpenAI: a standard-size model gets the nearest standard size; none usable → a plain 503', async () => {
    const ws = await space({ openai: OPENAI_KEY })
    openai.generate.mockImplementation(async (body: { model: string }) => {
      if (body.model !== 'gpt-image-1.5') throw openAiError(403, { message: `Project does not have access to model ${body.model}` })
      return imageOk()
    })
    const r = await generateImage({ workspaceId: ws, prompt: 'a red bicycle', aspect: '9:16', outDir })
    expect(r.model).toBe('gpt-image-1.5')
    expect(openai.generate.mock.calls[2][0].size).toBe('1024x1536')

    const ws2 = await space({ openai: OPENAI_KEY.replace('WXYZ', 'QRST') })
    openai.generate.mockRejectedValue(openAiError(404, { message: 'not found', code: 'model_not_found' }))
    const err = await failure(generateImage({ workspaceId: ws2, prompt: 'a red bicycle', aspect: '9:16', outDir }))
    expect(err.status).toBe(503)
    expect(err.message).toBe(
      'This OpenAI key can’t use any of the image models Producer Studio works with (gpt-image-2.5-flare, gpt-image-2, gpt-image-1.5). Check the key’s access in your OpenAI account, or add another provider’s key in Settings → AI.',
    )
    // capabilities stops offering stills for that key until the memo expires
    expect((await generationCapabilities(ws2)).image).toBeUndefined()
  })

  it('OpenAI: an unverified organization is told how to fix it', async () => {
    const ws = await space({ openai: OPENAI_KEY })
    openai.generate.mockRejectedValue(openAiError(403, { message: 'Your organization must be verified to use the model `gpt-image-2`.' }))
    const err = await failure(generateImage({ workspaceId: ws, prompt: 'x', aspect: '16:9', outDir }))
    expect(err).toMatchObject({ status: 403, message: expect.stringContaining('need a verified organization') })
  })

  it('OpenAI: a content-policy refusal is a readable 422, never the provider text; a rejected key never echoes the key', async () => {
    const ws = await space({ openai: OPENAI_KEY })
    openai.generate.mockRejectedValue(
      openAiError(400, { message: `Your request was rejected by the safety system (key ${OPENAI_KEY}).`, type: 'image_generation_user_error', code: 'moderation_blocked' }),
    )
    const err = await failure(generateImage({ workspaceId: ws, prompt: 'something it refuses', aspect: '16:9', outDir }))
    expect(err).toEqual(expect.objectContaining({ status: 422, message: 'OpenAI declined to make this image (its content rules). Try describing the scene differently.' }))
    expect(err.message).not.toMatch(/safety system/)

    openai.generate.mockRejectedValue(openAiError(401, { message: `Incorrect API key provided: ${OPENAI_KEY}` }))
    const auth = await failure(generateImage({ workspaceId: ws, prompt: 'x', aspect: '16:9', outDir }))
    expect(auth).toMatchObject({ status: 400, message: 'The OpenAI API key was rejected. Check or replace it in Settings → AI.' })
  })

  it('Gemini: generateContent with the aspect ratio (+ image size); the inline PNG is written', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    gemini.generateContent.mockResolvedValue(geminiImageOk())
    const r = await generateImage({ workspaceId: ws, prompt: 'a misty forest', aspect: '9:16', outDir })
    expect(r).toMatchObject({ mime: 'image/png', provider: 'gemini', model: 'gemini-nano-banana-2.1' })
    expect(r.file.endsWith('.png')).toBe(true)
    expect(fs.readFileSync(r.file).equals(PNG)).toBe(true)
    expect(keysSeen).toEqual([GEMINI_KEY])
    const req = gemini.generateContent.mock.calls[0][0]
    expect(req).toMatchObject({
      model: 'gemini-nano-banana-2.1',
      contents: [{ role: 'user', parts: [{ text: 'a misty forest' }] }],
      config: { imageConfig: { aspectRatio: '9:16', imageSize: '2K' } },
    })
  })

  it('Gemini: the first model 404s (advertised but not available), the second works', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    gemini.generateContent.mockImplementation(async (p: { model: string }) => {
      if (p.model === 'gemini-nano-banana-2.1') throw geminiError(404, `models/${p.model} is not found for API version v1beta, or is not supported for generateContent.`)
      return geminiImageOk()
    })
    const r = await generateImage({ workspaceId: ws, prompt: 'a misty forest', aspect: '16:9', outDir })
    expect(r.model).toBe('gemini-3.1-flash-image')
    expect(gemini.generateContent.mock.calls.map((c) => c[0].model)).toEqual(['gemini-nano-banana-2.1', 'gemini-3.1-flash-image'])
    expect((await generationCapabilities(ws)).image).toEqual({ provider: 'gemini', model: 'gemini-3.1-flash-image' })
  })

  it('Gemini: blocked prompts, safety stops and text-only answers are readable 422s', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    gemini.generateContent.mockResolvedValueOnce({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })
    const blocked = await failure(generateImage({ workspaceId: ws, prompt: 'x', aspect: '1:1', outDir }))
    expect(blocked).toMatchObject({ status: 422, message: 'Gemini declined to make this image (its content rules). Try describing the scene differently.' })
    gemini.generateContent.mockResolvedValueOnce({ candidates: [{ content: { parts: [] }, finishReason: 'IMAGE_SAFETY' }] })
    expect((await failure(generateImage({ workspaceId: ws, prompt: 'x', aspect: '1:1', outDir }))).status).toBe(422)
    gemini.generateContent.mockResolvedValueOnce({ candidates: [{ content: { parts: [{ text: 'I can’t draw that.' }] }, finishReason: 'STOP' }] })
    const textOnly = await failure(generateImage({ workspaceId: ws, prompt: 'x', aspect: '1:1', outDir }))
    expect(textOnly).toMatchObject({ status: 422, message: 'Gemini answered without an image. Try describing the scene differently.' })
    gemini.generateContent.mockRejectedValueOnce(geminiError(400, `API key not valid. Please pass a valid API key. (${GEMINI_KEY})`))
    expect(await failure(generateImage({ workspaceId: ws, prompt: 'x', aspect: '1:1', outDir }))).toMatchObject({ status: 400, message: expect.stringContaining('Gemini API key was rejected') })
  })

  it('account problems that look like rate limits get their real fix', async () => {
    const ws = await space({ openai: OPENAI_KEY })
    openai.generate.mockRejectedValue(openAiError(429, { message: 'Rate limit reached for gpt-image-2.5-flare on tokens per min (TPM): Limit 0, Used 0, Requested 6240.' }))
    expect(await failure(generateImage({ workspaceId: ws, prompt: 'x', aspect: '16:9', outDir }))).toMatchObject({ status: 403, message: expect.stringContaining('verified organization') })
    expect(openai.generate).toHaveBeenCalledTimes(1)
    const g = await space({ gemini: GEMINI_KEY })
    gemini.generateContent.mockRejectedValue(geminiError(429, 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-nano-banana-2.1'))
    expect(await failure(generateImage({ workspaceId: g, prompt: 'x', aspect: '16:9', outDir }))).toMatchObject({ status: 429, message: expect.stringContaining('no billing') })
    gemini.create.mockRejectedValue(geminiError(429, 'Quota exceeded for metric: free_tier_requests, limit: 0'))
    expect(await failure(generateVideo({ workspaceId: g, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))).toMatchObject({ status: 429, message: expect.stringContaining('no billing') })
  })

  it('a key the redaction patterns don’t know is still kept out of messages', async () => {
    const odd = 'AQ.Ab8RN6-oddly-shaped-gemini-key'
    const ws = await space({ gemini: odd })
    gemini.generateContent.mockRejectedValue(geminiError(403, `Permission denied on resource project for key ${odd}`))
    const err = await failure(generateImage({ workspaceId: ws, prompt: 'x', aspect: '16:9', outDir }))
    expect(err.message).not.toContain(odd)
    gemini.create.mockResolvedValue(running())
    gemini.get.mockResolvedValue({ id: 'int-1', status: 'failed', errors: [{ message: `backend error (${odd})` }] })
    const v = await failure(generateVideo({ workspaceId: ws, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))
    expect(v).toMatchObject({ status: 502, message: 'Gemini couldn’t make this clip: backend error ([redacted])' })
  })

  it('an aborted signal cancels', async () => {
    const ws = await space({ openai: OPENAI_KEY })
    const ac = new AbortController()
    openai.generate.mockImplementation(async () => {
      ac.abort()
      throw new OpenAI.APIUserAbortError()
    })
    await expect(generateImage({ workspaceId: ws, prompt: 'x', aspect: '16:9', outDir, signal: ac.signal })).rejects.toBeInstanceOf(CancelledError)
  })
})

// ---------------- clips ----------------

describe('generateVideo', () => {
  it('needs a Gemini key (OpenAI’s Sora API is gone)', async () => {
    const ws = await space({ openai: OPENAI_KEY })
    const err = await failure(generateVideo({ workspaceId: ws, prompt: 'waves', aspect: '16:9', seconds: 8, outDir }))
    expect(err.status).toBe(503)
    expect(err.message).toBe('AI video clips need a Gemini API key (OpenAI shut down its Sora video API in September 2026). Add one in Settings → AI.')
    const none = await space()
    expect((await failure(generateVideo({ workspaceId: none, prompt: 'waves', aspect: '16:9', seconds: 8, outDir }))).message).toMatch(/Gemini API key\. Add one in Settings → AI\./)
  })

  it('starts a background interaction, polls with backoff until it completes, writes the clip and reports progress', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    probeResult = async () => ({ duration: 9.96, width: 720, height: 1280 })
    gemini.create.mockResolvedValue(running('queued'))
    gemini.get.mockResolvedValueOnce(running('queued')).mockResolvedValueOnce(running()).mockResolvedValueOnce(running()).mockResolvedValueOnce(done())
    const progress: Array<[number, string]> = []
    const r = await generateVideo({ workspaceId: ws, prompt: 'waves at sunset', aspect: '9:16', seconds: 30, outDir, onProgress: (f, m) => progress.push([f, m]) })
    expect(r).toMatchObject({ mime: 'video/mp4', provider: 'gemini', model: 'gemini-omni-1.1-flash', seconds: 9.96, width: 720, height: 1280 })
    expect(fs.readFileSync(r.file).equals(MP4)).toBe(true)
    expect(keysSeen).toEqual([GEMINI_KEY])
    // 30 s asked for, 10 s is the model's most
    expect(gemini.create.mock.calls[0][0]).toEqual({
      model: 'gemini-omni-1.1-flash',
      input: 'waves at sunset',
      response_format: { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: '10s' },
      background: true,
    })
    expect(gemini.get).toHaveBeenCalledTimes(4)
    expect(gemini.get.mock.calls.every((c) => c[0] === 'int-1')).toBe(true)
    expect(sleeps).toEqual([5000, 7500, 11250, 16875])
    const fractions = progress.map(([f]) => f)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
    expect(progress[0]).toEqual([0, 'Starting the AI clip'])
    expect(progress[1][1]).toBe('Waiting in Gemini’s queue')
    expect(progress.at(-1)).toEqual([1, 'Clip ready'])
    expect(gemini.cancel).not.toHaveBeenCalled()
    expect(gemini.delete).toHaveBeenCalledWith('int-1', {}, expect.anything())
  })

  it('clamps short clips up to the model minimum; without ffprobe the clamped length is returned', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    probeResult = async () => {
      throw new Error('ffprobe failed')
    }
    gemini.create.mockResolvedValue(done())
    const r = await generateVideo({ workspaceId: ws, prompt: 'a spark', aspect: '1:1', seconds: 1, outDir })
    expect(r.seconds).toBe(3)
    expect(r.width).toBeUndefined()
    // 1:1 isn't offered: 16:9
    expect(gemini.create.mock.calls[0][0].response_format).toEqual({ type: 'video', aspect_ratio: '16:9', resolution: '720p', duration: '3s' })
    expect(gemini.get).not.toHaveBeenCalled()
  })

  it('falls back to a synchronous call when background mode is refused, then fetches the bytes', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    gemini.create.mockRejectedValueOnce(geminiError(400, 'background execution is not supported for model gemini-omni-1.1-flash')).mockResolvedValueOnce({ id: 'int-1', status: 'completed' })
    gemini.get.mockResolvedValue(done())
    const r = await generateVideo({ workspaceId: ws, prompt: 'waves', aspect: '16:9', seconds: 6, outDir })
    expect(fs.readFileSync(r.file).equals(MP4)).toBe(true)
    expect(gemini.create.mock.calls.map((c) => c[0].background)).toEqual([true, false])
    expect(gemini.get).toHaveBeenCalledTimes(1)
  })

  it('a fired signal cancels the remote interaction and stops', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    const ac = new AbortController()
    const clips = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.startsWith('ai-clip')).length : 0)
    const before = clips()
    gemini.create.mockResolvedValue(running())
    gemini.get.mockResolvedValueOnce(running()).mockImplementationOnce(async () => {
      ac.abort()
      return running()
    })
    await expect(generateVideo({ workspaceId: ws, prompt: 'waves', aspect: '16:9', seconds: 8, outDir, signal: ac.signal })).rejects.toBeInstanceOf(CancelledError)
    expect(gemini.cancel).toHaveBeenCalledWith('int-1', {}, expect.anything())
    expect(gemini.get).toHaveBeenCalledTimes(2)
    expect(clips()).toBe(before)
  })

  it('gives up after 15 minutes: cancels the remote job and says so plainly', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    gemini.create.mockResolvedValue(running())
    gemini.get.mockResolvedValue(running())
    const start = clock
    const err = await failure(generateVideo({ workspaceId: ws, prompt: 'waves', aspect: '16:9', seconds: 8, outDir }))
    expect(err).toMatchObject({ status: 504, message: expect.stringContaining('wasn’t ready after 15 minutes') })
    expect(clock - start).toBe(15 * 60_000)
    expect(Math.max(...sleeps)).toBe(20_000)
    expect(gemini.cancel).toHaveBeenCalledWith('int-1', {}, expect.anything())
  })

  it('rides out a few failed status checks', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    gemini.create.mockResolvedValue(running())
    gemini.get.mockRejectedValueOnce(geminiError(503, 'The service is currently unavailable.')).mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(done())
    const r = await generateVideo({ workspaceId: ws, prompt: 'waves', aspect: '16:9', seconds: 8, outDir })
    expect(r.model).toBe('gemini-omni-1.1-flash')
  })

  it('a safety failure is a readable 422; other failures are plain and redacted', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    gemini.create.mockResolvedValue(running())
    gemini.get.mockResolvedValueOnce({ id: 'int-1', status: 'failed', errors: [{ code: 'RAI_FILTERED', message: 'The prompt was blocked by safety filters (person generation).' }] })
    const err = await failure(generateVideo({ workspaceId: ws, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))
    expect(err).toMatchObject({ status: 422, message: 'Gemini declined to make this clip (its content rules). Try describing the scene differently.' })
    gemini.get.mockResolvedValueOnce({ id: 'int-1', status: 'failed', errors: [{ message: `internal error for key=${GEMINI_KEY}` }] })
    const other = await failure(generateVideo({ workspaceId: ws, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))
    expect(other).toMatchObject({ status: 502, message: 'Gemini couldn’t make this clip: internal error for [redacted]' })
    gemini.create.mockRejectedValueOnce(geminiError(429, 'Resource has been exhausted (e.g. check quota).'))
    expect(await failure(generateVideo({ workspaceId: ws, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))).toMatchObject({ status: 429 })
  })

  it('a video model the key can’t use → a plain 503 naming it, and capabilities stops offering clips', async () => {
    const ws = await space({ gemini: GEMINI_KEY })
    gemini.create.mockRejectedValue(geminiError(404, 'models/gemini-omni-1.1-flash is not found for API version v1beta'))
    const err = await failure(generateVideo({ workspaceId: ws, prompt: 'x', aspect: '16:9', seconds: 8, outDir }))
    expect(err).toMatchObject({ status: 503, message: expect.stringContaining('can’t use any of the video models Producer Studio works with (gemini-omni-1.1-flash)') })
    expect((await generationCapabilities(ws)).video).toBeUndefined()
    expect((await generationCapabilities(ws)).image?.provider).toBe('gemini')
  })
})

// ---------------- stock ----------------

const pexelsVideo = (id: number, duration: number, files: Array<[number | null, number | null, string?]>) => ({
  id,
  width: 1920,
  height: 1080,
  url: `https://www.pexels.com/video/clip-${id}/`,
  image: `https://images.pexels.com/videos/${id}/preview.jpeg`,
  duration,
  user: { id: 9, name: `Creator ${id}`, url: `https://www.pexels.com/@creator${id}` },
  video_files: files.map(([w, h, type], i) => ({ id: id * 10 + i, quality: 'hd', file_type: type ?? 'video/mp4', width: w, height: h, fps: 25, link: `https://videos.pexels.com/video-files/${id}/${w}x${h}.mp4` })),
})

describe('stock footage', () => {
  it('needs the server’s Pexels key', async () => {
    const err = await failure(searchStock({ query: 'ocean', aspect: '16:9' }))
    expect(err).toMatchObject({ status: 503, message: expect.stringContaining('free Pexels API key') })
  })

  it('searches by orientation, puts long-enough clips first and picks the rendition nearest 1080p', async () => {
    ctx().config.pexelsApiKey = PEXELS_KEY
    fetchMock.mockImplementation(async () =>
      Response.json({
        videos: [
          pexelsVideo(1, 4, [
            [640, 360],
            [3840, 2160],
            [1920, 1080],
            [null, null, 'application/x-mpegURL'],
          ]),
          pexelsVideo(2, 14, [
            [720, 1280],
            [1440, 2560],
          ]),
          pexelsVideo(3, 20, [[null, null, 'application/x-mpegURL']]),
        ],
      }),
    )
    const clips = await searchStock({ query: ' city at night ', aspect: '9:16', minSeconds: 6 })
    const [url, init] = fetchMock.mock.calls[0]
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://api.pexels.com/v1/videos/search')
    expect(Object.fromEntries(u.searchParams)).toEqual({ query: 'city at night', orientation: 'portrait', per_page: '40' })
    expect(init.headers).toMatchObject({ Authorization: PEXELS_KEY })
    expect(clips.map((c) => c.id)).toEqual(['2', '1'])
    expect(clips[0]).toEqual({
      id: '2',
      url: 'https://videos.pexels.com/video-files/2/1440x2560.mp4',
      previewImage: 'https://images.pexels.com/videos/2/preview.jpeg',
      width: 1440,
      height: 2560,
      duration: 14,
      author: 'Creator 2',
      authorUrl: 'https://www.pexels.com/@creator2',
      pageUrl: 'https://www.pexels.com/video/clip-2/',
    })
    expect(clips[1]).toMatchObject({ url: 'https://videos.pexels.com/video-files/1/1920x1080.mp4', width: 1920, height: 1080 })

    await searchStock({ query: 'ocean', aspect: '16:9' })
    await searchStock({ query: 'ocean', aspect: '1:1' })
    expect(fetchMock.mock.calls.slice(1).map((c) => new URL(c[0]).searchParams.get('orientation'))).toEqual(['landscape', 'square'])
  })

  it('maps Pexels errors to plain messages', async () => {
    ctx().config.pexelsApiKey = PEXELS_KEY
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }))
    expect(await failure(searchStock({ query: 'ocean', aspect: '16:9' }))).toMatchObject({ status: 429, code: 'quota' })
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    expect(await failure(searchStock({ query: 'ocean', aspect: '16:9' }))).toMatchObject({ status: 503, message: expect.stringContaining('Pexels key was rejected') })
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await failure(searchStock({ query: 'ocean', aspect: '16:9' }))).toMatchObject({ status: 502 })
  })

  it('downloads a clip from Pexels only', async () => {
    probeResult = async () => ({ duration: 14, width: 1440, height: 2560 })
    const clip: StockClip = {
      id: '2',
      url: 'https://videos.pexels.com/video-files/2/1440x2560.mp4',
      previewImage: '',
      width: 1440,
      height: 2560,
      duration: 14,
      author: 'Creator 2',
      authorUrl: 'https://www.pexels.com/@creator2',
      pageUrl: 'https://www.pexels.com/video/clip-2/',
    }
    fetchMock.mockResolvedValue(new Response(MP4, { headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) } }))
    const r = await downloadStock(clip, outDir)
    expect(r).toMatchObject({ mime: 'video/mp4', provider: 'pexels', model: 'stock', width: 1440, height: 2560 })
    expect(fs.readFileSync(r.file).equals(MP4)).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe(clip.url)

    for (const url of ['https://169.254.169.254/latest/meta-data', 'http://videos.pexels.com/x.mp4', 'https://evil.example/pexels.com.mp4', 'not a url']) {
      const err = await failure(downloadStock({ ...clip, url }, outDir))
      expect(err.status).toBe(400)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockResolvedValueOnce(new Response('<html>', { headers: { 'content-type': 'text/html' } }))
    expect((await failure(downloadStock(clip, outDir))).status).toBe(502)
  })
})
