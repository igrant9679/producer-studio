// Producer AI assembly never loses work: it uses the brief as it is now, keeps edits made to the project while it ran
// (and refuses to replace an edited timeline), reuses the voices a failed run made, asks before re-assembling over
// edits, and can assemble into a copy. Kokoro is replaced by a short sine WAV; everything else is real.
import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AudioItem, createShapeItem, type Project, type ProjectDocResponse, type ScriptScene } from '@producer/core'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { editedSinceAssembly, produceAssemble, sceneSpans, timelineFingerprint } from '../ai/produce'
import { MUSIC_DUCK_DB, sfxManifest } from '../ai/soundtrack'
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

  it('adds music composed on the cuts (ducked under the voice) and sound effects as clips, made once and reused', async () => {
    const id = await newProject('With sound')
    const ideaScenes: ScriptScene[] = [
      { ...scenes[0], visual: { kind: 'motion', points: ['Every morning', 'One view'] } },
      { ...scenes[1], visual: { kind: 'diagram', diagram: { type: 'steps', items: ['Open', 'Look', 'Decide'] } } },
    ]
    const go = async () => {
      const a = await assemble(id, { scenes: ideaScenes, brief: { ...brief, source: 'idea', idea: 'A tour of the dashboard', music: 'mallet', soundEffects: true } })
      expect(a.status).toBe(200)
      return a.run()
    }
    const made = (kind: string) => ctx().db.select().from(assets).where(eq(assets.workspaceId, workspaceId)).then((rows) => rows.filter((r) => r.meta.generated?.kind === kind))
    const res = await go()
    expect(res.notes).toBeUndefined()
    const p = (await load(id)).project
    const layout = sceneSpans(ideaScenes, new Map(ideaScenes.map((s) => [s.id, { duration: 1.2 }])))
    // the music: one clip the length of the video, on its own track that ducks under the narration
    const music = p.tracks.find((t) => t.name === 'Music')!
    expect(music.duck).toBe(MUSIC_DUCK_DB)
    expect(music.items).toHaveLength(1)
    const song = p.assets[(music.items[0] as AudioItem).assetId]
    expect(song.duration).toBeGreaterThan(layout.duration - 0.2)
    expect(song.duration).toBeLessThan(layout.duration + 0.2)
    expect((await made('music'))[0].meta.generated).toMatchObject({ provider: 'huashu-motion', model: 'mallet' })
    // the effects: a whoosh whose peak lands on each cut, a landing on the title, pops on the graphics, a ding at the close
    const fx = p.tracks.find((t) => t.name === 'Sound effects')!
    const names = fx.items.map((i) => i.name)
    expect(names.filter((n) => n === 'cut sound')).toHaveLength(3)
    expect(names).toEqual(expect.arrayContaining(['title sound', 'appear sound', 'close sound']))
    const whoosh = sfxManifest()!.kits.crisp.roles['whoosh.short']
    const cuts = fx.items.filter((i) => i.name === 'cut sound')
    cuts.forEach((it, k) => {
      const take = whoosh.takes.find((t) => p.assets[(it as AudioItem).assetId].name.includes(t.file.split('/')[1].replace('.ogg', '')))!
      expect(it.start + take.sync).toBeCloseTo([...layout.spans.map((s) => s.start), layout.closeStart][k], 2)
    })
    expect(fx.items.every((i) => i.start >= 0 && (i as AudioItem).volume > 0 && (i as AudioItem).volume <= 1)).toBe(true)
    // assembled again unchanged: the same music and the same effect files, nothing made twice
    const counts = [(await made('music')).length, (await made('sfx')).length]
    await go()
    expect([(await made('music')).length, (await made('sfx')).length]).toEqual(counts)
    // no music and no effects asked for: neither track
    const plain = await assemble(id, { scenes: ideaScenes, brief: { ...brief, music: 'off', soundEffects: false } })
    await plain.run()
    expect((await load(id)).project.tracks.map((t) => t.name)).not.toEqual(expect.arrayContaining(['Music']))
    expect((await load(id)).project.tracks.some((t) => t.name === 'Sound effects')).toBe(false)
  }, 240_000)

  it('an AI-drawn scene is rendered into a clip filling the frame, reused while nothing changed; one with no AI becomes text', async ({ skip }) => {
    if (!ctx().config.chromePath || !fs.existsSync(ctx().config.chromePath!)) skip()
    const id = await newProject('Drawn')
    const code = 'function draw(ctx, t, env) { ctx.fillStyle = env.palette.accent; ctx.fillRect(40 + t * 50, env.H / 2 - 40, 80, 80); }'
    const drawn: ScriptScene[] = [
      { ...scenes[0], visual: { kind: 'drawn', prompt: 'A square slides right', code } },
      // no code yet and no AI in this space: animated text, with the reason
      { ...scenes[1], visual: { kind: 'drawn', prompt: 'A circle grows' } },
    ]
    const run = async (sc: ScriptScene[]) => {
      const r = await client.json('POST', '/api/ai/produce/assemble', { projectId: id, scenes: sc, brief: { ...brief, source: 'idea', idea: 'Shapes' } })
      expect(r.status).toBe(200)
      const job = (await getJob(r.body.id))!
      const out = await produceAssemble(inlineContext({ id: job.id, kind: 'ai.produce.assemble', workspaceId, userId: job.userId, projectId: id, input: job.input }))
      return { out, p: (await load(id)).project }
    }
    const { out, p } = await run(drawn)
    const made = p.ai!.script!.scenes[0].visual as Extract<ScriptScene['visual'], { kind: 'drawn' }>
    expect(made).toMatchObject({ kind: 'drawn', code, assetId: expect.any(String) })
    expect(p.tracks.find((t) => t.main)!.items.find((i) => i.type === 'video')).toMatchObject({ assetId: made.assetId, fit: 'cover', muted: true })
    const row = (await ctx().db.select().from(assets).where(eq(assets.id, made.assetId!)))[0]
    expect(row).toMatchObject({ origin: 'ai', kind: 'video', status: 'ready' })
    expect(row.meta.generated).toMatchObject({ kind: 'drawn', model: 'code' })
    expect(p.ai!.script!.scenes[1].visual?.kind).toBe('motion')
    expect(out.notes?.[0]).toMatch(/^s02: /)
    // again, unchanged: the same clip
    const again = await run(p.ai!.script!.scenes.map((s, i) => (i === 0 ? s : drawn[1])))
    expect((again.p.ai!.script!.scenes[0].visual as { assetId?: string }).assetId).toBe(made.assetId)
  }, 240_000)

  it('assembles your own image from the library, and never one from another space', async () => {
    const id = await newProject('From my photos')
    const me = (await client.json('GET', '/api/auth/me')).body.user.id as string
    const other = await signup((await setup()).app, 'Someone else')
    const now = Date.now()
    const row = (assetId: string, ws: string, by: string) => ({ id: assetId, workspaceId: ws, kind: 'image', name: `${assetId}.png`, mime: 'image/png', status: 'ready', origin: 'upload', meta: { width: 800, height: 600 }, sourceKey: `ws/${ws}/assets/${assetId}/source.png`, createdBy: by, createdAt: now, updatedAt: now })
    const otherUser = (await other.client.json('GET', '/api/auth/me')).body.user.id as string
    await ctx().db.insert(assets).values([row('as_mine_photo', workspaceId, me), row('as_theirs_photo', other.workspaceId, otherUser)] as never)
    const own: ScriptScene[] = [
      { ...scenes[0], visual: { kind: 'media', assetId: 'as_mine_photo' } },
      { ...scenes[1], visual: { kind: 'media', assetId: 'as_theirs_photo' } },
    ]
    const r = await client.json('POST', '/api/ai/produce/assemble', { projectId: id, scenes: own, brief: { ...brief, source: 'idea', idea: 'Our photos' } })
    expect(r.status).toBe(200)
    const job = (await getJob(r.body.id))!
    await produceAssemble(inlineContext({ id: job.id, kind: 'ai.produce.assemble', workspaceId, userId: job.userId, projectId: id, input: job.input }))
    const p = (await load(id)).project
    const main = p.tracks.find((t) => t.main)!
    expect(main.items.find((i) => i.type === 'image')).toMatchObject({ assetId: 'as_mine_photo', fit: 'cover' })
    expect(JSON.stringify(p.tracks)).not.toContain('as_theirs_photo')
    expect(p.assets.as_theirs_photo).toBeUndefined()
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
