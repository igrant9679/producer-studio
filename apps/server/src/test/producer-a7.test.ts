// Producer AI (A-7): the script's versions come from the project's version history; one scene can be narrated again
// (a fresh take, or in its own voice and speed) while the others keep theirs; a video uses the brand kit its brief
// names. Kokoro is replaced by a short tone; everything else is real.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BrandKitSummary, Project, ProjectDocResponse, ScriptScene, ScriptVersion } from '@producer/core'
import { produceAssemble } from '../ai/produce'
import { tts } from '../ai/tts'
import { getJob } from '../jobs/queue'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { type Client, setup, signup } from './helpers'

let client: Client
let workspaceId = ''
const brief = { title: 'Spring tour', audience: 'Ops', goal: 'Show the dashboard', tone: 'Friendly', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const }
const scenes: ScriptScene[] = [
  { id: 's01', title: 'Hook', headline: 'Meet the dashboard', narration: 'Here is the dashboard you will see every morning.', footage: [] },
  { id: 's02', title: 'Close', headline: 'Start today', narration: 'Open it today and see for yourself.', footage: [] },
]
const spoken: Array<{ text: string; voice: string; speed: number }> = []

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app, 'Producer')
  client = u.client
  workspaceId = u.workspaceId
  vi.spyOn(tts, 'synthesize').mockImplementation(async (text, out, opts) => {
    spoken.push({ text, voice: opts.voice, speed: opts.speed })
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=24000', '-t', '1.2', out])
    return { duration: 1.2, sampleRate: 24000 }
  })
})
afterEach(() => {
  spoken.length = 0
})

async function newProject(): Promise<string> {
  const r = await client.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId, name: 'Tour', kind: 'producer', width: 1920, height: 1080 })
  return r.body.project.id
}
const load = async (id: string) => (await client.json<ProjectDocResponse>('GET', `/api/projects/${id}`)).body.project

async function assemble(projectId: string, body: Record<string, unknown> = {}) {
  const r = await client.json('POST', '/api/ai/produce/assemble', { projectId, scenes, brief, ...body })
  expect(r.status).toBe(200)
  const job = (await getJob(r.body.id))!
  return produceAssemble(inlineContext({ id: job.id, kind: 'ai.produce.assemble', workspaceId, userId: job.userId, projectId: job.projectId, input: job.input }))
}

describe('Producer AI (A-7)', () => {
  it('narrates one scene again: a fresh take of it, or its own voice and speed, while the other keeps its voice', async () => {
    const id = await newProject()
    await assemble(id)
    expect(spoken.map((s) => s.text)).toEqual([scenes[0].narration, scenes[1].narration])
    spoken.length = 0
    // the same words, a new take of s01 only
    await assemble(id, { renarrate: ['s01'], replace: true })
    expect(spoken).toEqual([{ text: scenes[0].narration, voice: 'af_heart', speed: 1 }])
    spoken.length = 0
    // s02 in its own voice, a little faster
    const own = [scenes[0], { ...scenes[1], narrator: { voice: 'am_eric', speed: 1.2 } }]
    await assemble(id, { scenes: own, replace: true })
    expect(spoken).toEqual([{ text: scenes[1].narration, voice: 'am_eric', speed: 1.2 }])
    const p = await load(id)
    expect(p.ai?.script?.scenes[1].narrator).toEqual({ voice: 'am_eric', speed: 1.2 })
    // an unknown voice for a scene falls back like the brief's
    expect((await client.json('POST', '/api/ai/produce/assemble', { projectId: id, scenes: [{ ...scenes[0], narrator: { speed: 9 } }], brief, replace: true })).status).toBe(400)
  })

  it('makes the video in the brand kit its brief names (the default when that kit is gone)', async () => {
    const kit = (await client.json<BrandKitSummary>('POST', `/api/workspaces/${workspaceId}/brand-kits`, { doc: { name: 'Retail', colors: ['#123456', '#ffcc00', '#fefefe'], fonts: { headline: 'Oswald', body: 'Inter' } } })).body
    const id = await newProject()
    await assemble(id, { brief: { ...brief, brandKitId: kit.id } })
    const p: Project = await load(id)
    expect(p.background).toBe('#123456')
    expect(p.ai?.brief?.brandKitId).toBe(kit.id)
    await client.json('DELETE', `/api/workspaces/${workspaceId}/brand-kits/${kit.id}`)
    await assemble(id, { brief: { ...brief, brandKitId: kit.id }, replace: true })
    expect((await load(id)).background).not.toBe('#123456')
  })

  it('lists the script’s versions from the project’s history, newest first, one per change', async () => {
    const id = await newProject()
    const save = (narration: string) => client.json('PUT', '/api/ai/produce/draft', { projectId: id, brief, scenes: [{ ...scenes[0], narration }, scenes[1]] })
    expect((await save('First take of the hook.')).status).toBe(200)
    // a save that changes nothing in the script (the same again) adds no entry
    await save('First take of the hook.')
    await save('Second, better take of the hook.')
    const r = await client.json<ScriptVersion[]>('GET', `/api/ai/produce/${id}/script-versions`)
    expect(r.status).toBe(200)
    expect(r.body.map((v) => v.scenes[0].narration)).toEqual(['Second, better take of the hook.', 'First take of the hook.'])
    expect(r.body[0]).toMatchObject({ brief: { title: 'Spring tour' }, words: 13, authorName: 'Producer' })
    const other = await signup((await setup()).app, 'Stranger')
    expect((await other.client.json('GET', `/api/ai/produce/${id}/script-versions`)).status).toBe(404)
  })
})
