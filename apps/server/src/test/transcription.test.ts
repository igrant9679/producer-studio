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
import { Client, setup, signup } from './helpers'

let client: Client
let workspaceId = ''
let userId = ''
let dir = ''
let silent = ''
let talk = ''
const saved: { cli?: string; model?: string } = {}

const jc = (kind = 'asset.process') => inlineContext({ id: `t-${kind}`, kind, workspaceId, userId, projectId: null, input: {} })

async function clip(file: string, name: string, mime = 'video/mp4', kind: 'video' | 'audio' | 'image' = 'video') {
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

  it('Producer AI makes a video from an idea with your own clips and images, and shows the writer each one', async () => {
    const calls = fakeWhisper()
    const photoFile = path.join(dir, 'team.png')
    await proc.ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x3366cc:s=320x240', '-frames:v', '1', photoFile])
    const beach = await clip(talk, 'beach.mp4')
    const photo = await clip(photoFile, 'team.png', 'image/png', 'image')
    const seen: Array<{ prompt: string; images: Array<{ label: string; data: string }> }> = []
    vi.spyOn(provider, 'requireProvider').mockResolvedValue({
      id: 'anthropic-api',
      status: async () => ({ available: true }),
      write: async () => '',
      runAgent: async () => ({ text: '' }),
      structured: async (req: { prompt: string; images: Array<{ label: string; data: string }> }) => {
        seen.push(req)
        const blank = { points: [], diagramType: 'none', items: [], details: [], values: [], unit: '', center: '', leftTitle: '', leftPoints: [], rightTitle: '', rightPoints: [], prompt: '', query: '', mediaId: '' }
        return {
          message: 'A good trip',
          scenes: [
            { id: 's01', title: 'Team', headline: 'Our team', narration: 'This is our team.', visual: { ...blank, kind: 'media', mediaId: 'm2' } },
            { id: 's02', title: 'Beach', headline: 'The beach', narration: 'And this is where we went.', visual: { ...blank, kind: 'media', mediaId: 'm1' } },
            { id: 's03', title: 'Close', headline: 'See you', narration: 'See you next year.', visual: { ...blank, kind: 'motion', points: ['Next year'] } },
          ],
        }
      },
    } as unknown as provider.AiProvider)
    const project = await client.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId, name: 'Team trip', kind: 'producer', width: 1920, height: 1080 })
    const brief = { title: 'Team trip', audience: 'Staff', goal: 'Remember it', tone: 'Warm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const, source: 'idea' as const, idea: 'Our team trip to the coast' }
    const out = await produceScript(inlineContext({ id: 'j-idea-media', kind: 'ai.produce.script', workspaceId, userId, projectId: project.body.project.id, input: { projectId: project.body.project.id, assetIds: [beach.id, photo.id], brief } }))
    expect(out.script.scenes.map((sc) => sc.visual)).toEqual([
      { kind: 'media', assetId: photo.id },
      { kind: 'media', assetId: beach.id },
      { kind: 'motion', points: ['Next year'] },
    ])
    expect(seen[0].prompt).toContain('YOUR MEDIA')
    expect(seen[0].prompt).toContain('- m1 · video clip, 2 s · "beach.mp4"')
    expect(seen[0].prompt).toContain('- m2 · image · "team.png"')
    // a picture of each: three frames across the clip, and the image
    expect(seen[0].images.map((i) => i.label)).toEqual(['m1 (three frames across the clip):', 'm2 (image):'])
    expect(seen[0].images.every((i) => i.data.length > 100)).toBe(true)
    // nothing is transcribed for a video made from an idea
    expect(calls).toHaveLength(0)
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

  it('the app is told which model is installed and what it can hear, for the language picker (P-20)', async () => {
    useModel('ggml-small.en.bin')
    const en = (await client.json('GET', '/api/ai/transcription')).body
    expect(en).toMatchObject({ available: true, model: 'ggml-small.en.bin', multilingual: false, detect: false, languages: [{ code: 'en', name: 'English' }] })
    expect(en.summary).toMatch(/English only.*multilingual model/)
    useModel('ggml-small.bin')
    const multi = (await client.json('GET', '/api/ai/transcription')).body
    expect(multi).toMatchObject({ model: 'ggml-small.bin', multilingual: true, detect: true })
    expect(multi.languages[0]).toEqual({ code: 'en', name: 'English' })
    expect(multi.languages).toEqual(expect.arrayContaining([{ code: 'fr', name: 'French' }, { code: 'ja', name: 'Japanese' }]))
    expect(multi.languages.length).toBeGreaterThan(90)
    expect(multi.summary).toMatch(/about 100 languages/)
    // distil-whisper models only hear English, whatever their name says
    useModel('ggml-distil-large-v3.bin')
    expect((await client.json('GET', '/api/ai/transcription')).body.multilingual).toBe(false)
    ctx().config.whisperModel = path.join(dir, 'missing.bin')
    expect((await client.json('GET', '/api/ai/transcription')).body).toMatchObject({ available: false, summary: expect.stringMatching(/isn’t set up/) })
    // signed-in people only
    expect((await new Client((await setup()).app).json('GET', '/api/ai/transcription')).status).toBe(401)
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
