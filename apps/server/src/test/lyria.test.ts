// AI music for the media library (21 Nov 2026): one song from Google's Lyria on a space's Gemini key, over the
// Interactions API. A stand-in Gemini client answers as Google's music guide says (the song in the same answer, as a
// base64 audio block); the real one spends the space's credit.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setKeyClients } from '../ai/keys'
import { setGenerateClients } from '../ai/generate/capabilities'
import { generateMusic, songOf } from '../ai/generate/music'
import { ffmpeg } from '../media/proc'
import { setup, signup, type TestEnv } from './helpers'

let t: TestEnv
let workspaceId = ''
let noKeySpace = ''
let MP3: Buffer
const GEMINI_KEY = 'AIzaSyLYRIAKEY0123456789abcdefg'
const create = vi.fn()
const del = vi.fn()

beforeAll(async () => {
  t = await setup()
  const dir = path.join(t.dataDir, 'lyria-fixtures')
  fs.mkdirSync(dir, { recursive: true })
  await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-c:a', 'aac', '-b:a', '96k', path.join(dir, 'song.m4a')])
  MP3 = fs.readFileSync(path.join(dir, 'song.m4a'))
  setKeyClients({
    openai: () => ({ responses: { create: async () => (async function* () {})() }, models: { async *list() {} } }),
    gemini: () => ({
      models: {
        generateContentStream: async () => (async function* () {})(),
        list: async () =>
          (async function* () {
            yield { name: 'models/gemini-3-pro', supportedActions: ['generateContent'] }
          })(),
      },
    }),
  } as never)
  const u = await signup(t.app, 'Music maker')
  workspaceId = u.workspaceId
  expect((await u.client.json('PUT', '/api/ai/keys/gemini', { workspaceId, key: GEMINI_KEY })).status).toBe(200)
  noKeySpace = (await signup(t.app, 'No key')).workspaceId
}, 120_000)
afterAll(() => {
  setKeyClients(undefined)
  setGenerateClients(undefined)
})
beforeEach(() => {
  create.mockReset()
  del.mockReset()
  del.mockResolvedValue(undefined)
  setGenerateClients({
    gemini: () => ({ models: { generateContent: vi.fn() }, interactions: { create, get: vi.fn(), cancel: vi.fn(), delete: del } }),
    probe: async (file: string) => ({ duration: file.endsWith('.json') ? 0 : 8 }),
    now: () => Date.now(),
    sleep: async () => undefined,
  } as never)
})

describe('the song in Google’s answer', () => {
  it('is the SDK’s audio helper, or the last audio block of the turns or outputs', () => {
    expect(songOf({ id: 'a', status: 'completed', output_audio: { data: 'QUJD', mime_type: 'audio/mpeg' } })).toEqual({ data: 'QUJD', mime: 'audio/mpeg' })
    expect(songOf({ id: 'b', status: 'completed', steps: [{ content: [{ type: 'text', text: 'lyrics' }, { type: 'audio', data: 'WFla', mime_type: 'audio/wav; rate=44100' }] }] })).toEqual({ data: 'WFla', mime: 'audio/wav' })
    expect(songOf({ id: 'c', status: 'completed', outputs: [{ type: 'audio', data: 'TU5P' }] })).toEqual({ data: 'TU5P', mime: 'audio/mpeg' })
    expect(songOf({ id: 'd', status: 'completed', outputs: [{ type: 'text', text: 'no song' }] })).toBeUndefined()
  })
})

describe('a song for the library', () => {
  it('asks Lyria 3.5 for it on the space’s Gemini key, keeps the file and deletes Google’s copy', async () => {
    create.mockResolvedValue({ id: 'int-1', status: 'completed', output_audio: { data: MP3.toString('base64'), mime_type: 'audio/mpeg' } })
    const out = path.join(t.dataDir, 'lyria-out')
    const song = await generateMusic({ workspaceId, prompt: 'Instrumental only, no vocals. A jazz trio.', outDir: out })
    expect(create).toHaveBeenCalledWith({ model: 'lyria-3.5', input: 'Instrumental only, no vocals. A jazz trio.' }, expect.anything())
    expect(song).toMatchObject({ mime: 'audio/mpeg', seconds: 8, model: 'lyria-3.5' })
    expect(song.file.endsWith('.mp3')).toBe(true)
    expect(fs.readFileSync(song.file)).toEqual(MP3)
    expect(del).toHaveBeenCalledWith('int-1', {}, expect.anything())
  })

  it('tries the older full-song model when the key can’t use Lyria 3.5', async () => {
    create.mockImplementation(async (body: { model: string }) => {
      if (body.model === 'lyria-3.5') throw Object.assign(new Error('models/lyria-3.5 is not found'), { status: 404 })
      return { id: 'int-2', status: 'completed', output_audio: { data: MP3.toString('base64'), mime_type: 'audio/mpeg' } }
    })
    const song = await generateMusic({ workspaceId, prompt: 'Instrumental only. Reggae.', outDir: path.join(t.dataDir, 'lyria-out') })
    expect(song.model).toBe('lyria-3-pro-preview')
    expect(create.mock.calls.map((c) => c[0].model)).toEqual(['lyria-3.5', 'lyria-3-pro-preview'])
  })

  it('asks once more for an original piece when Google’s copyright filter stops the wording', async () => {
    create.mockImplementationOnce(async () => {
      throw Object.assign(new Error('400 Request blocked due to copyright/recitation content. Please modify your input and retry.'), { status: 400 })
    })
    create.mockResolvedValueOnce({ id: 'int-4', status: 'completed', output_audio: { data: MP3.toString('base64'), mime_type: 'audio/mpeg' } })
    const song = await generateMusic({ workspaceId, prompt: 'Instrumental only. Lo-fi.', outDir: path.join(t.dataDir, 'lyria-out') })
    expect(song.model).toBe('lyria-3.5')
    expect(create.mock.calls.map((c) => c[0].input)).toEqual(['Instrumental only. Lo-fi.', expect.stringMatching(/^An original composition, not based on or imitating any existing song.*Instrumental only\. Lo-fi\.$/)])
    // blocked again: said, not tried a third time
    create.mockReset()
    create.mockRejectedValue(Object.assign(new Error('400 Request blocked due to copyright/recitation content.'), { status: 400 }))
    await expect(generateMusic({ workspaceId, prompt: 'x', outDir: path.join(t.dataDir, 'lyria-out') })).rejects.toThrow(/recitation/)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('says so when Google answers without a song, and when the space has no Gemini key', async () => {
    create.mockResolvedValue({ id: 'int-3', status: 'completed', outputs: [{ type: 'text', text: 'I can’t do that' }] })
    await expect(generateMusic({ workspaceId, prompt: 'x', outDir: path.join(t.dataDir, 'lyria-out') })).rejects.toThrow(/without a song/)
    await expect(generateMusic({ workspaceId: noKeySpace, prompt: 'x', outDir: path.join(t.dataDir, 'lyria-out') })).rejects.toThrow(/AI music needs a Gemini API key/)
  })
})
