// Producer AI assembly never loses work: it uses the brief as it is now, keeps edits made to the project while it ran
// (and refuses to replace an edited timeline), reuses the voices a failed run made, asks before re-assembling over
// edits, and can assemble into a copy. Kokoro is replaced by a short sine WAV; everything else is real.
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createShapeItem, type Project, type ProjectDocResponse, type ScriptScene } from '@producer/core'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { editedSinceAssembly, produceAssemble, timelineFingerprint } from '../ai/produce'
import { tts } from '../ai/tts'
import { getJob } from '../jobs/queue'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { type Client, setup, signup } from './helpers'

let client: Client
let workspaceId = ''

const brief = { title: 'Spring tour', audience: 'Ops managers', goal: 'Show the new dashboard', tone: 'Friendly', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const }
const scenes: ScriptScene[] = [
  { id: 's01', title: 'Hook', headline: 'Meet the dashboard', narration: 'Here is the dashboard you will see every morning.', footage: [] },
  { id: 's02', title: 'Close', headline: 'Start today', narration: 'Open it today and see for yourself.', footage: [] },
]

/** Stands in for Kokoro: a 1.2 s tone per line; `during(text)` runs while that line is being voiced. */
let during: (text: string) => Promise<void> = async () => undefined
const spoken: Array<{ text: string; voice: string }> = []
beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app, 'Producer')
  client = u.client
  workspaceId = u.workspaceId
  vi.spyOn(tts, 'synthesize').mockImplementation(async (text, out, opts) => {
    spoken.push({ text, voice: opts.voice })
    await during(text)
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=24000', '-t', '1.2', out])
    return { duration: 1.2, sampleRate: 24000 }
  })
})
afterEach(() => {
  during = async () => undefined
  spoken.length = 0
})

async function newProject(name = 'Spring tour'): Promise<string> {
  const r = await client.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId, name, kind: 'producer', width: 1920, height: 1080 })
  expect(r.status).toBe(200)
  return r.body.project.id
}
const load = async (id: string) => (await client.json<ProjectDocResponse>('GET', `/api/projects/${id}`)).body

/** Ask for an assembly, then run its job here (tests run no worker). */
async function assemble(projectId: string, body: Record<string, unknown> = {}) {
  const r = await client.json('POST', '/api/ai/produce/assemble', { projectId, scenes, brief, ...body })
  if (r.status !== 200) return { status: r.status, body: r.body, run: async () => undefined as never }
  const job = (await getJob(r.body.id))!
  const run = () => produceAssemble(inlineContext({ id: job.id, kind: 'ai.produce.assemble', workspaceId, userId: job.userId, projectId: job.projectId, input: job.input }))
  return { status: r.status, body: r.body, run }
}

/** Save an edit to the timeline the way the editor does. */
async function editTimeline(projectId: string) {
  const cur = await load(projectId)
  const doc: Project = structuredClone(cur.project)
  doc.tracks[0].items.push(createShapeItem(Math.max(0, ...doc.tracks[0].items.map((i) => i.start + i.duration)), { name: 'My own card', duration: 2 }))
  const r = await client.json('PUT', `/api/projects/${projectId}`, { project: doc, baseVersion: cur.version })
  expect(r.status).toBe(200)
}
const hasMyCard = (p: Project) => p.tracks.some((t) => t.items.some((i) => i.name === 'My own card'))

describe('Producer AI assembly', () => {
  it('uses the brief as it is now: voice, look and title changed after the script was written', async () => {
    const id = await newProject()
    const a = await assemble(id, { brief: { ...brief, title: 'Autumn tour', voice: 'am_eric' } })
    expect(a.status).toBe(200)
    await a.run()
    expect(spoken.map((s) => s.voice)).toEqual(['am_eric', 'am_eric'])
    const p = (await load(id)).project
    expect(p.tracks.some((t) => t.items.some((i) => i.type === 'text' && i.text === 'Autumn tour'))).toBe(true)
    expect(p.ai?.brief).toMatchObject({ title: 'Autumn tour', voice: 'am_eric' })
  })

  it('assembles a video made from an idea (animated text and a diagram) the same way', async () => {
    const id = await newProject('From an idea')
    const ideaScenes: ScriptScene[] = [
      { ...scenes[0], visual: { kind: 'motion', points: ['Every morning', 'One view'] } },
      { ...scenes[1], visual: { kind: 'diagram', diagram: { type: 'steps', items: ['Open', 'Look', 'Decide'] } } },
    ]
    const r = await client.json('POST', '/api/ai/produce/assemble', { projectId: id, scenes: ideaScenes, brief: { ...brief, source: 'idea', idea: 'A tour of the dashboard' } })
    expect(r.status).toBe(200)
    const job = (await getJob(r.body.id))!
    await produceAssemble(inlineContext({ id: job.id, kind: 'ai.produce.assemble', workspaceId, userId: job.userId, projectId: id, input: job.input }))
    const p = (await load(id)).project
    expect(p.ai?.status).toBe('assembled')
    expect(p.ai?.script?.scenes.map((s) => s.visual?.kind)).toEqual(['motion', 'diagram'])
    expect(p.tracks.some((t) => t.items.some((i) => i.type === 'text' && i.text === 'Decide'))).toBe(true)
  })

  it('keeps a rename made while it ran', async () => {
    const id = await newProject()
    const a = await assemble(id)
    during = async (text) => {
      if (text !== scenes[1].narration) return
      expect((await client.json('PATCH', `/api/projects/${id}`, { name: 'Renamed meanwhile' })).status).toBe(200)
    }
    await a.run()
    const p = await load(id)
    expect(p.project.name).toBe('Renamed meanwhile')
    expect(p.project.ai?.status).toBe('assembled')
    expect(p.project.tracks.find((t) => t.name === 'Voiceover')?.items).toHaveLength(2)
  })

  it('never replaces a timeline edited while it ran: the new assembly goes into a copy, and it says so', async () => {
    const id = await newProject()
    const a = await assemble(id)
    expect(a.status).toBe(200)
    during = async (text) => {
      if (text === scenes[1].narration) await editTimeline(id)
    }
    const result = await a.run()
    expect(result.message).toMatch(/edited .*while it was being assembled.*kept.*copy/)
    const p = (await load(id)).project
    expect(hasMyCard(p)).toBe(true)
    expect(p.ai?.status).not.toBe('assembled')
    // the copy has the new assembly, with the voices this run made (not voiced twice)
    const copy = await load(result.copyProjectId!)
    expect(copy.summary.name).toBe('Spring tour (new assembly)')
    expect(copy.project.ai?.status).toBe('assembled')
    expect(hasMyCard(copy.project)).toBe(false)
    expect(copy.project.tracks.find((t) => t.name === 'Voiceover')?.items).toHaveLength(2)
    expect(spoken).toHaveLength(2)
    expect(editedSinceAssembly(copy.project)).toBe(false)
  })

  it('a retry reuses the voices the failed run made; each voice records its job', async () => {
    const id = await newProject()
    const first = await assemble(id)
    during = async (text) => {
      if (text === scenes[1].narration) throw new Error('TTS worker exited (code 1)')
    }
    await expect(first.run()).rejects.toThrow(/TTS worker exited/)
    const made = await ctx().db.select().from(assets).where(eq(assets.projectId, id))
    expect(made.map((m) => [m.status, m.meta.jobId])).toEqual([['ready', first.body.id]])
    during = async () => undefined
    spoken.length = 0
    const retry = await assemble(id)
    await retry.run()
    // only the scene that never got a voice is voiced again
    expect(spoken.map((s) => s.text)).toEqual([scenes[1].narration])
    const voiceTrack = (await load(id)).project.tracks.find((t) => t.name === 'Voiceover')!
    expect(voiceTrack.items.map((i) => (i.type === 'audio' ? i.assetId : ''))[0]).toBe(made[0].id)
  })

  it('asks before re-assembling over edits made since, then replaces them or assembles into a copy', async () => {
    const id = await newProject()
    const a = await assemble(id)
    await a.run()
    let p = (await load(id)).project
    expect(editedSinceAssembly(p)).toBe(false)
    expect(p.ai?.assembled?.fingerprint).toBe(timelineFingerprint(p))
    // unchanged since: no question
    expect((await assemble(id)).status).toBe(200)

    await editTimeline(id)
    const asked = await assemble(id)
    expect(asked.status).toBe(409)
    expect(asked.body).toMatchObject({ code: 'conflict', details: { reason: 'edited' } })

    // into a copy: this project keeps its edits, the copy gets the new assembly
    const copy = await assemble(id, { intoCopy: true })
    expect(copy.status).toBe(200)
    expect(copy.body.projectId).not.toBe(id)
    await copy.run()
    const c = await load(copy.body.projectId)
    expect(c.summary).toMatchObject({ name: 'Spring tour copy', kind: 'producer', workspaceId })
    expect(c.project.ai?.status).toBe('assembled')
    expect(hasMyCard(c.project)).toBe(false)
    p = (await load(id)).project
    expect(hasMyCard(p)).toBe(true)

    // replace: the edits go
    const replaced = await assemble(id, { replace: true })
    expect(replaced.status).toBe(200)
    await replaced.run()
    expect(hasMyCard((await load(id)).project)).toBe(false)
  })

  it('a timeline built by hand before any assembly counts as edits; an empty one does not', async () => {
    const id = await newProject()
    expect(editedSinceAssembly((await load(id)).project)).toBe(false)
    await editTimeline(id)
    expect((await assemble(id)).status).toBe(409)
  })
})

describe('wizard drafts', () => {
  it('saves brief and script edits to the project as typed, leaving the timeline alone', async () => {
    const id = await newProject()
    await (await assemble(id)).run()
    const before = await load(id)
    // a scene still being written has no narration yet
    const edited: ScriptScene[] = [{ ...scenes[0], narration: 'Edited on the Review step.' }, { ...scenes[1], id: 'sc_new_x1', narration: '' }]
    const r = await client.json('PUT', '/api/ai/produce/draft', { projectId: id, brief: { ...brief, voice: 'am_eric' }, scenes: edited, scriptBrief: brief })
    expect(r.status).toBe(200)
    expect(r.body.version).toBe(before.version + 1)
    const p = (await load(id)).project
    expect(p.ai?.script?.scenes).toEqual(edited)
    expect(p.ai?.script?.brief).toMatchObject(brief)
    expect(p.ai).toMatchObject({ brief: { voice: 'am_eric' }, status: 'assembled' })
    expect(p.tracks).toEqual(before.project.tracks)
    // a draft is not a timeline edit: re-assembling doesn't ask
    expect(editedSinceAssembly(p)).toBe(false)
  })

  it('needs an editor of the project’s space', async () => {
    const id = await newProject()
    const other = await signup((await setup()).app, 'Outsider')
    expect((await other.client.json('PUT', '/api/ai/produce/draft', { projectId: id, brief, scenes })).status).toBe(404)
  })
})
