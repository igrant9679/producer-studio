// Transcription finishes: a clip with no sound gets an empty transcript (and Producer AI writes from it as footage)
// instead of failing on ffmpeg's "does not contain any stream" (PIP-1); a requested language is used by a
// multilingual model, auto-detected when none is asked for, and refused in words by an English-only one (PIP-31).
// whisper.cpp itself is replaced: the test servers have no model, and none is downloaded here.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProjectDocResponse } from '@producer/core'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { produceScript } from '../ai/produce'
import * as provider from '../ai/provider'
import { transcribeAsset } from '../ai/speech'
import { whisperLanguage } from '../ai/whisper'
import { inlineContext } from '../jobs/worker'
import * as proc from '../media/proc'
import { processAsset } from '../media/process'
import { createAssetFromFile, loadAsset } from '../services/assets'
import { type Client, setup, signup } from './helpers'

let client: Client
let workspaceId = ''
let userId = ''
let dir = ''
let silent = ''
let talk = ''
const saved: { cli?: string; model?: string } = {}

const jc = (kind = 'asset.process') => inlineContext({ id: `t-${kind}`, kind, workspaceId, userId, projectId: null, input: {} })

async function clip(file: string, name: string, mime = 'video/mp4', kind: 'video' | 'audio' = 'video') {
  const a = await createAssetFromFile({ workspaceId, userId, filePath: file, name, mime, kind, origin: 'upload' })
  return processAsset(a.id, jc())
}

/** Point the server at a "whisper.cpp" and a model of this name (the binary is never run: runOk is replaced). */
function useModel(name: string) {
  const model = path.join(dir, name)
  fs.writeFileSync(model, 'not a model')
  ctx().config.whisperCli = process.execPath
  ctx().config.whisperModel = model
}

/** Stands in for whisper.cpp: records the arguments and writes the JSON it would. */
function fakeWhisper(language = 'en') {
  const real = proc.runOk
  const calls: string[][] = []
  vi.spyOn(proc, 'runOk').mockImplementation(async (cmd, args, opts, what) => {
    if (cmd !== ctx().config.whisperCli) return real(cmd, args, opts, what)
    calls.push(args)
    const base = args[args.indexOf('-of') + 1]
    const json = { result: { language }, transcription: [{ text: ' Bonjour à tous', offsets: { from: 0, to: 900 }, tokens: [{ text: ' Bonjour', offsets: { from: 0, to: 400 } }, { text: ' à', offsets: { from: 400, to: 500 } }, { text: ' tous', offsets: { from: 500, to: 900 } }] }] }
    fs.writeFileSync(`${base}.json`, JSON.stringify(json))
    return { code: 0, stdout: '', stderr: '' }
  })
  return calls
}

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app, 'Transcriber')
  client = u.client
  workspaceId = u.workspaceId
  userId = (await client.json('GET', '/api/auth/me')).body.user.id
  saved.cli = ctx().config.whisperCli
  saved.model = ctx().config.whisperModel
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-stt-'))
  // a screen recording without a microphone, and a clip with sound
  silent = path.join(dir, 'screen.mp4')
  await proc.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent])
  talk = path.join(dir, 'talk.mp4')
  await proc.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talk])
})
afterEach(() => {
  vi.restoreAllMocks()
  ctx().config.whisperCli = saved.cli
  ctx().config.whisperModel = saved.model
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('clips with no sound (PIP-1)', () => {
  it('get an empty transcript, not ffmpeg text', async () => {
    useModel('ggml-small.en.bin')
    const calls = fakeWhisper()
    const row = await clip(silent, 'screen.mp4')
    expect(row.meta.hasAudio).toBe(false)
    const r = await transcribeAsset(row.id, undefined, jc('ai.transcribe'))
    expect(r.transcript.segments).toEqual([])
    expect((await loadAsset(row.id)).meta.transcript?.segments).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('also when the clip was processed before processing recorded the sound track', async () => {
    useModel('ggml-small.en.bin')
    fakeWhisper()
    const row = await clip(silent, 'old-screen.mp4')
    // fixture: a clip from before hasAudio was stored
    const { hasAudio: _drop, ...meta } = row.meta
    await ctx().db.update(assets).set({ meta }).where(eq(assets.id, row.id))
    const r = await transcribeAsset(row.id, undefined, jc('ai.transcribe'))
    expect(r.transcript.segments).toEqual([])
  })

  it('can be transcribed on a server without whisper', async () => {
    const row = await clip(silent, 'screen-2.mp4')
    ctx().config.whisperCli = undefined
    const res = await client.json('POST', '/api/ai/transcribe', { assetId: row.id })
    expect(res.status).toBe(200)
  })

  it('Producer AI writes the script with a silent recording as footage instead of failing on it', async () => {
    useModel('ggml-small.en.bin')
    const calls = fakeWhisper()
    const screen = await clip(silent, 'screen-3.mp4')
    const voice = await clip(talk, 'talk.mp4')
    const prompts: string[] = []
    vi.spyOn(provider, 'requireProvider').mockResolvedValue({
      id: 'anthropic-api',
      status: async () => ({ available: true }),
      write: async () => '',
      runAgent: async () => ({ text: '' }),
      structured: async (req: { prompt: string }) => {
        prompts.push(req.prompt)
        return { message: 'It works', scenes: [{ id: 's01', title: 'Hook', headline: 'See it', narration: 'Here it is, working.', footage: [{ assetId: screen.id, start: 0, end: 1.5, note: 'the screen' }], visuals: '' }] }
      },
    } as unknown as provider.AiProvider)
    const project = await client.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId, name: 'Silent tour', kind: 'producer', width: 1920, height: 1080 })
    const brief = { title: 'Silent tour', audience: 'Ops', goal: 'Show it', tone: 'Friendly', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const }
    const out = await produceScript(inlineContext({ id: 'j-script', kind: 'ai.produce.script', workspaceId, userId, projectId: project.body.project.id, input: { projectId: project.body.project.id, assetIds: [screen.id, voice.id], brief } }))
    expect(out.script.scenes[0].footage[0].assetId).toBe(screen.id)
    expect(prompts[0]).toContain(screen.id)
    // only the clip with sound went to whisper
    expect(calls).toHaveLength(1)
  })
})

describe('transcription languages (PIP-31)', () => {
  it('an English-only model takes English and says plainly it cannot do another language', async () => {
    expect(whisperLanguage(undefined, 'ggml-small.en.bin')).toBe('en')
    expect(whisperLanguage('en-US', '/opt/whisper/ggml-small.en.bin')).toBe('en')
    expect(() => whisperLanguage('fr', 'ggml-base.en-q5_1.bin')).toThrow(/only understands English, so it can't transcribe French/)
  })

  it('a multilingual model auto-detects, or uses the language asked for', async () => {
    expect(whisperLanguage(undefined, 'ggml-small.bin')).toBe('auto')
    expect(whisperLanguage('auto', 'ggml-large-v3-turbo.bin')).toBe('auto')
    expect(whisperLanguage('pt-BR', 'ggml-small.bin')).toBe('pt')
    expect(() => whisperLanguage('klingon', 'ggml-small.bin')).toThrow(/doesn't support the language/)
  })

  it('asking an English-only server for French is refused when asked, not transcribed as English', async () => {
    useModel('ggml-small.en.bin')
    const row = await clip(talk, 'talk-fr.mp4')
    const res = await client.json('POST', '/api/ai/transcribe', { assetId: row.id, language: 'fr' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/only understands English/)
  })

  it('whisper is told the language asked for, or to detect it, and the transcript says which it was', async () => {
    useModel('ggml-small.bin')
    const calls = fakeWhisper('fr')
    const row = await clip(talk, 'talk-auto.mp4')
    const auto = await transcribeAsset(row.id, undefined, jc('ai.transcribe'))
    expect(calls[0][calls[0].indexOf('-l') + 1]).toBe('auto')
    expect(auto.transcript.language).toBe('fr')
    expect(auto.transcript.segments[0].text).toBe('Bonjour à tous')
    await transcribeAsset(row.id, 'fr-CA', jc('ai.transcribe'))
    expect(calls[1][calls[1].indexOf('-l') + 1]).toBe('fr')
  })
})
