// Producer uses the media library on its own (23 Nov 2026, after the owner's ask that the library's clips and songs be
// "available for users to insert into their videos and customize based on their needs/brand/topic"): the script
// writer may show a library clip where one shows what a scene says, the music can be a library song (the one picked,
// or the one that suits the tone) cut to the video's length at the level composed music sits at, and the brand goes
// on: the kit's logo on the title and closing cards, and its stamp in the corner through the scenes. Kokoro and the
// library's makers are replaced by quick stand-ins; the rest is real (ffmpeg included).
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type AudioItem,
  type ImageItem,
  type ProjectDocResponse,
  type ScriptScene,
  type TextItem,
  type VideoItem,
  isLibraryMusic,
  libraryClipAbout,
  libraryItem,
  libraryKitFor,
  librarySongFor,
  logoStamp,
  musicChoice,
  CLIP_LIBRARY,
  CLIP_SOUND_VERSION,
  MUSIC_LIBRARY,
  createProject,
} from '@producer/core'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { allowedVisualKinds, buildProducerTimeline, headingLines, readyLibraryClips, sceneSpans } from '../ai/produce'
import { motionItems } from '../ai/scene-layout'
import { getLook, lookPalette } from '../services/looks'
import { type IdeaScriptOutput, buildIdeaPrompt, normalizeIdeaScript } from '../ai/scenes'
import { MUSIC_LUFS, fitSong } from '../ai/soundtrack'
import { tts } from '../ai/tts'
import { getJob } from '../jobs/queue'
import { inlineContext, type JobContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { probe, processAsset } from '../media/process'
import { measureLoudness } from '../render/loudness'
import { createAssetFromFile } from '../services/assets'
import { CLIP_LUFS, LIBRARY_MAKERS, addLibraryItem, forgetLibraryInfo, libraryInfo, listClips, makeLibraryJob, scoreClip } from '../services/media-library'
import { type Client, produceAssembleHere, setup, signup } from './helpers'

let client: Client
let workspaceId = ''
let userId = ''
const real = { ...LIBRARY_MAKERS }
const brief = { title: 'Morning ritual', audience: 'Coffee lovers', goal: 'Brew better', tone: 'Friendly', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const, source: 'idea' as const, idea: 'How to brew' }

/** Has the library item made (by the stand-ins below) the way an operator's job would. */
async function make(id: string) {
  const jc = { job: { id: `j_${id}`, kind: 'library.make', workspaceId, userId, input: { item: id } }, signal: new AbortController().signal, progress: () => undefined, check: () => undefined } as unknown as JobContext
  await makeLibraryJob(jc)
}

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app, 'Library producer')
  client = u.client
  workspaceId = u.workspaceId
  userId = (await client.json<{ user: { id: string } }>('GET', '/api/auth/me')).body.user.id
  vi.spyOn(tts, 'synthesize').mockImplementation(async (_text, out) => {
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=24000', '-t', '1.2', out])
    return { duration: 1.2, sampleRate: 24000 }
  })
  // a 6 s song (shorter than any video, so it is looped) and a 2 s clip
  LIBRARY_MAKERS.music = async (o) => {
    const file = path.join(o.outDir, 'song.m4a')
    await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-af', 'volume=0.6', '-c:a', 'aac', '-b:a', '128k', file])
    return { file, mime: 'audio/mp4', seconds: 6, provider: 'gemini', model: 'lyria-3.5' }
  }
  LIBRARY_MAKERS.motion = async (o) => {
    const file = path.join(o.outDir, 'clip.mp4')
    await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', file])
    return { file, mime: 'video/mp4', seconds: 2, provider: 'gemini', model: 'gemini-omni-1.2-flash' }
  }
}, 120_000)
afterAll(() => {
  Object.assign(LIBRARY_MAKERS, real)
  forgetLibraryInfo()
})

describe('choosing a library song', () => {
  it('plays the song picked, or the tone’s best that has been made, and falls back to composed music without the library', () => {
    const ready = ['bright-ideas', 'still-water', 'neon-pulse']
    expect(musicChoice('library:still-water', 'Friendly', ready)).toEqual({ library: 'still-water' })
    expect(musicChoice('library', 'Friendly', ready)).toEqual({ library: 'bright-ideas' })
    expect(musicChoice('library', 'Calm', ready)).toEqual({ library: 'still-water' })
    expect(musicChoice('library', 'quite energetic', ready)).toEqual({ library: 'neon-pulse' })
    // a song not made (or gone): the tone's; no library at all (a desktop): the tone's composed style
    expect(musicChoice('library:arena-stomp', 'Friendly', ready)).toEqual({ library: 'bright-ideas' })
    expect(musicChoice('library', 'Calm', [])).toEqual({ style: 'ambient' })
    // the composed choices are as before
    expect(musicChoice('auto', 'Calm', ready)).toEqual({ style: 'ambient' })
    expect(musicChoice('lofi', 'Calm', ready)).toEqual({ style: 'lofi' })
    expect(musicChoice('off', 'Calm', ready)).toBeUndefined()
    expect(musicChoice(undefined, 'Calm', ready)).toBeUndefined()
    // a tone it doesn't know still gets a song, and every tone's songs are in the library
    expect(librarySongFor('mysterious', ready)).toBe('bright-ideas')
    expect(librarySongFor('Calm', ['rainy-desk'])).toBe('rainy-desk')
    expect(librarySongFor('Calm', [])).toBeUndefined()
    expect(isLibraryMusic('library')).toBe(true)
    expect(isLibraryMusic('library:front-porch')).toBe(true)
    expect(isLibraryMusic('auto')).toBe(false)
    // effects to match: soft under quiet songs, punchy under beats
    expect(libraryKitFor({ genre: 'Solo piano' })).toBe('calm')
    expect(libraryKitFor({ genre: 'Drum and bass' })).toBe('launch')
    expect(libraryKitFor({ genre: 'Corporate pop' })).toBe('crisp')
    for (const t of MUSIC_LIBRARY) expect(['calm', 'crisp', 'launch']).toContain(libraryKitFor(t))
  })

  it('names only songs that are in the library', async () => {
    const { LIBRARY_SONGS_BY_TONE } = await import('@producer/core')
    for (const ids of Object.values(LIBRARY_SONGS_BY_TONE)) for (const id of ids) expect(libraryItem(id)?.kind, id).toBe('music')
  })
})

describe('the script writer and the library', () => {
  const clips = [{ id: 'coffee-pour', title: 'Coffee Pour', kind: 'motion' as const, about: 'Slow-motion close-up of hot coffee being poured.', seconds: 8 }]
  const blank: IdeaScriptOutput['scenes'][number]['visual'] = { kind: 'motion', points: [], diagramType: 'none', items: [], details: [], values: [], unit: '', center: '', leftTitle: '', leftPoints: [], rightTitle: '', rightPoints: [], prompt: '', query: '', mediaId: '', libraryId: '', animStyle: 'none', objects: [], labels: [] }

  it('lists the clips made, by id and in words, only when library clips may be used', () => {
    const p = buildIdeaPrompt({ brief, kinds: ['motion', 'library'], rules: 'r', example: 'e', library: clips })
    expect(p).toMatch(/- library: one of the ready-made LIBRARY CLIPS/)
    expect(p).toMatch(/LIBRARY CLIPS \(ready-made/)
    expect(p).toContain('- coffee-pour · filmed-looking video, 8 s · Coffee Pour: Slow-motion close-up of hot coffee being poured.')
    // not ticked, or nothing made: no word of it
    expect(buildIdeaPrompt({ brief, kinds: ['motion'], rules: 'r', example: 'e', library: clips })).not.toMatch(/LIBRARY CLIPS/)
    expect(buildIdeaPrompt({ brief, kinds: ['motion', 'library'], rules: 'r', example: 'e', library: [] })).not.toMatch(/library/i)
    // what an animation shows, without the drawing instructions it was made with
    const rocket = CLIP_LIBRARY.find((c) => c.id === 'rocket-launch')!
    expect(libraryClipAbout(rocket)).toBe('A cartoon rocket lifts off from its launch pad in a puff of smoke, climbs through fluffy clouds and arcs into a starry sky.')
  })

  it('turns a library pick into a library scene, and a pick it can’t show into animated text', () => {
    const out: IdeaScriptOutput = {
      message: 'm',
      cast: [],
      scenes: [
        { id: 'a', title: 'Pour', headline: 'The pour', narration: 'Pour slowly.', visual: { ...blank, kind: 'library', libraryId: 'Coffee-Pour ' } },
        { id: 'b', title: 'Nope', headline: 'Unknown', narration: 'Something else.', visual: { ...blank, kind: 'library', libraryId: 'rocket-launch' } },
      ],
    }
    const scenes = normalizeIdeaScript(out, ['motion', 'library'], [], clips)
    expect(scenes[0].visual).toEqual({ kind: 'library', id: 'coffee-pour' })
    expect(scenes[1].visual).toEqual({ kind: 'motion', points: ['Unknown'] })
    // library clips not allowed for this video: text
    expect(normalizeIdeaScript(out, ['motion'], [], clips)[0].visual?.kind).toBe('motion')
  })
})

describe('a song cut to the video', () => {
  it('cuts a long song with a fade at the end, and loops a short one with a crossfade, at the level asked', async () => {
    const dir = path.join(ctx().config.dataDir, 'fit-song')
    fs.mkdirSync(dir, { recursive: true })
    const long = path.join(dir, 'long.m4a')
    await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=20', '-c:a', 'aac', long])
    const cut = path.join(dir, 'cut.m4a')
    await fitSong({ src: long, seconds: 20, duration: 7, lufs: -30, out: cut })
    expect((await probe(cut)).duration).toBeCloseTo(7, 0)
    expect((await measureLoudness(cut))!.i).toBeCloseTo(-30, 0)
    const short = path.join(dir, 'short.m4a')
    await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-c:a', 'aac', short])
    const looped = path.join(dir, 'looped.m4a')
    await fitSong({ src: short, seconds: 8, duration: 21, lufs: -18, out: looped })
    expect((await probe(looped)).duration).toBeCloseTo(21, 0)
    expect((await measureLoudness(looped))!.i).toBeCloseTo(-18, 0)
  }, 60_000)
})

describe('a video Producer makes with the library', () => {
  const load = async (id: string) => (await client.json<ProjectDocResponse>('GET', `/api/projects/${id}`)).body.project
  const newProject = async (name: string) => (await client.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId, name, kind: 'producer', width: 1920, height: 1080 })).body.project.id
  const assemble = async (projectId: string, scenes: ScriptScene[], b: Record<string, unknown>) => {
    const r = await client.json('POST', '/api/ai/produce/assemble', { projectId, scenes, brief: { ...brief, ...b } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const job = (await getJob(r.body.id))!
    return produceAssembleHere(inlineContext({ id: job.id, kind: 'ai.produce.assemble', workspaceId, userId: job.userId, projectId, input: job.input }))
  }
  const scenes: ScriptScene[] = [
    { id: 's01', title: 'Pour', headline: 'The slow pour', narration: 'Pour the water slowly, in circles.', footage: [], visual: { kind: 'library', id: 'coffee-pour' } },
    { id: 's02', title: 'Close', headline: 'Enjoy', narration: 'Then sit back and enjoy it.', footage: [], visual: { kind: 'motion', points: ['Enjoy'] } },
  ]

  it('offers library clips only once some have been made', async () => {
    forgetLibraryInfo()
    expect(await allowedVisualKinds(workspaceId, ['motion', 'library'])).toEqual(['motion'])
    await make('coffee-pour')
    await make('bright-ideas')
    expect(await allowedVisualKinds(workspaceId, ['motion', 'library'])).toEqual(['motion', 'library'])
    // offered by default, and said to the wizard
    expect(await allowedVisualKinds(workspaceId)).toContain('library')
    const caps = await client.json<{ kinds: string[] }>('GET', `/api/ai/produce/capabilities?workspaceId=${workspaceId}`)
    expect(caps.body.kinds).toContain('library')
    expect((await readyLibraryClips()).map((c) => c.id)).toEqual(['coffee-pour'])
  }, 60_000)

  it('shows the library clip full frame, plays the tone’s library song cut to the video, and stamps the brand’s name', async () => {
    const id = await newProject('Morning ritual')
    const res = await assemble(id, scenes, { music: 'library', soundEffects: true, logoStamp: true })
    expect(res.notes).toBeUndefined()
    const p = await load(id)
    // the clip: the space's copy of the library's, filling the frame, kept on the script for the next assembly
    const visual = p.ai!.script!.scenes[0].visual as { kind: string; id: string; assetId: string }
    expect(visual).toMatchObject({ kind: 'library', id: 'coffee-pour' })
    const copy = (await ctx().db.select().from(assets).where(eq(assets.id, visual.assetId)))[0]
    expect(copy.meta.generated).toMatchObject({ kind: 'library', prompt: 'coffee-pour v1' })
    const main = p.tracks.find((t) => t.main)!
    const shown = main.items.filter((i): i is VideoItem => i.type === 'video' && i.assetId === visual.assetId)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown[0].fit).toBe('cover')
    // the song: Bright Ideas (the friendly tone's), the video's length, at the composed music's level, ducked
    const music = p.tracks.find((t) => t.name === 'Music')!
    expect(music.duck).toBeGreaterThan(0)
    const song = p.assets[(music.items[0] as AudioItem).assetId]
    expect(song.name).toBe('Music · Bright Ideas')
    const row = (await ctx().db.select().from(assets).where(eq(assets.id, song.id)))[0]
    expect(row.meta.generated).toMatchObject({ kind: 'music', provider: 'library', model: 'bright-ideas' })
    const layout = sceneSpans(scenes, new Map(scenes.map((s) => [s.id, { duration: 1.2 }])))
    expect(song.duration).toBeGreaterThan(layout.duration - 0.3)
    expect(song.duration).toBeLessThan(layout.duration + 0.3)
    const file = path.join(ctx().config.dataDir, 'fitted.m4a')
    await ctx().storage.download(row.sourceKey, file)
    expect((await measureLoudness(file))!.i).toBeCloseTo(MUSIC_LUFS, 0)
    // effects in the kit that goes with the song
    expect(p.tracks.some((t) => t.name === 'Sound effects')).toBe(true)
    // the stamp: no logo in the kit, so its name, from the end of the title card to the closing card
    const stamp = p.tracks.find((t) => t.name === 'Brand stamp')!.items[0] as TextItem
    const kit = (await client.json<{ name: string }>('GET', `/api/workspaces/${workspaceId}/brand`)).body
    expect(stamp.text).toBe(kit.name)
    expect(stamp.start).toBe(3)
    expect(stamp.start + stamp.duration).toBeCloseTo(layout.closeStart!, 2)
    expect(stamp.transform.x).toBeGreaterThan(0)
    expect(stamp.transform.y).toBeGreaterThan(0)
    expect(p.tracks.some((t) => t.name === 'Logo')).toBe(false)
    // assembled again: the same copy and the same fitted song, nothing made twice
    const count = async () => (await ctx().db.select().from(assets).where(eq(assets.workspaceId, workspaceId))).filter((r) => ['library', 'music'].includes(r.meta.generated?.kind ?? '')).length
    const before = await count()
    await assemble(id, (await load(id)).ai!.script!.scenes, { music: 'library', soundEffects: true, logoStamp: true })
    expect(await count()).toBe(before)
    // no stamp asked for: none
    await assemble(id, scenes, { music: 'off', logoStamp: false })
    const plain = await load(id)
    expect(plain.tracks.some((t) => t.name === 'Brand stamp' || t.name === 'Music')).toBe(false)
  }, 240_000)

  it('puts the kit’s logo on the title and closing cards, and stamps it in the corner', async () => {
    const png = path.join(ctx().config.dataDir, 'logo.png')
    await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:size=400x200', '-frames:v', '1', png])
    const made = await createAssetFromFile({ workspaceId, userId, filePath: png, name: 'Logo', mime: 'image/png', kind: 'image', origin: 'upload' })
    const logo = await processAsset(made.id, { signal: new AbortController().signal, check: () => undefined, progress: () => undefined })
    const cur = await client.json<Record<string, unknown>>('GET', `/api/workspaces/${workspaceId}/brand`)
    const put = await client.json('PUT', `/api/workspaces/${workspaceId}/brand`, { ...cur.body, logoAssetId: logo.id })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    const id = await newProject('With a logo')
    await assemble(id, scenes, { music: 'off', logoStamp: true })
    const p = await load(id)
    const marks = p.tracks.find((t) => t.name === 'Logo')!.items as ImageItem[]
    expect(marks.map((i) => i.name)).toEqual(['Title logo', 'Close logo', 'Logo stamp'])
    expect(marks.every((i) => i.assetId === logo.id)).toBe(true)
    expect(p.assets[logo.id]).toBeTruthy()
    // the cards' logo above the words, the stamp small in the bottom-right corner
    expect(marks[0].transform.x).toBe(0)
    expect(marks[0].transform.y).toBeLessThan(0)
    const st = logoStamp({ width: 1920, height: 1080 }, { width: 400, height: 200 }, 0.1)
    expect(marks[2].transform).toMatchObject({ x: st.x, y: st.y })
    expect(marks[2].transform.scale).toBeCloseTo(st.scale, 3)
    expect(st.w).toBeCloseTo(192, 0)
    expect(p.tracks.some((t) => t.name === 'Brand stamp')).toBe(false)
  }, 240_000)

  it('shows a scene’s words when its library clip can’t be added, and keeps the pick for next time', async () => {
    const id = await newProject('Missing clip')
    const res = await assemble(id, [{ ...scenes[0], visual: { kind: 'library', id: 'rocket-launch' } }, scenes[1]], { music: 'off' })
    expect(res.notes?.join(' ')).toMatch(/s01: the library clip couldn’t be added \(This item of the library hasn’t been made yet\)/)
    const p = await load(id)
    expect(p.ai!.script!.scenes[0].visual).toEqual({ kind: 'library', id: 'rocket-launch' })
    expect(p.tracks.some((t) => t.items.some((i) => i.type === 'text' && (i as TextItem).text === 'The slow pour'))).toBe(true)
  }, 240_000)

  it('gives a full-motion clip a library song in place of the sound it was made with, once, keeping the file as made', async () => {
    await make('morning-espresso')
    const clip = libraryItem('coffee-pour') as (typeof CLIP_LIBRARY)[number]
    expect(clip.song).toBe('morning-espresso')
    const before = (await libraryInfo(clip))!
    expect(before.sound).toBeUndefined()
    expect(await scoreClip(clip)).toBe('scored')
    const after = (await libraryInfo(clip))!
    expect(after.key).toBe('library/clips/coffee-pour.v1.s1.mp4')
    expect(after.sound).toEqual({ song: 'morning-espresso', rev: CLIP_SOUND_VERSION, original: before.key })
    expect(await ctx().storage.stat(before.key)).toBeTruthy()
    // the picture as it was, with the song's sound, as long as the clip, at a clip's own loudness
    const file = path.join(ctx().config.dataDir, 'scored.mp4')
    await ctx().storage.download(after.key, file)
    const p = await probe(file)
    expect(p).toMatchObject({ kind: 'video', hasAudio: true })
    expect(p.duration).toBeCloseTo(before.seconds, 0)
    expect((await measureLoudness(file))!.i).toBeCloseTo(CLIP_LUFS, 0)
    // done once; listed with its song; and a space adding it now gets the new sound, not the copy it had
    expect(await scoreClip(clip)).toBe('already')
    expect((await listClips()).find((c) => c.id === 'coffee-pour')).toMatchObject({ song: 'morning-espresso' })
    expect((await listClips()).find((c) => c.id === 'rocket-launch')?.song).toBeUndefined()
    const copy = await addLibraryItem({ it: clip, workspaceId, userId, signal: new AbortController().signal })
    expect(copy.meta.generated).toMatchObject({ prompt: 'coffee-pour v1 s1' })
    // a clip whose song isn't made, and an animation, are left as they are
    expect(await scoreClip(libraryItem('city-dusk') as (typeof CLIP_LIBRARY)[number])).toBe('not made')
    expect(await scoreClip(libraryItem('rocket-launch') as (typeof CLIP_LIBRARY)[number])).toBe('no song')
  }, 120_000)

  it('takes library music and the stamp in a brief, and nothing outside the library', async () => {
    const id = await newProject('Brief check')
    const draft = (b: Record<string, unknown>) => client.json('PUT', '/api/ai/produce/draft', { projectId: id, brief: { ...brief, ...b }, scenes: [] })
    expect((await draft({ music: 'library:front-porch', logoStamp: true, visualKinds: ['motion', 'library'] })).status).toBe(200)
    expect((await draft({ music: 'library' })).status).toBe(200)
    expect((await draft({ music: 'library:no-such-song' })).status).toBe(400)
  })
})

describe('the cards and the points', () => {
  const voice = (id: string, text: string) => ({ asset: { id, kind: 'audio' as const, name: id, src: '', duration: 1.5 }, duration: 1.5, text })
  const scenes: ScriptScene[] = [{ id: 's01', title: 'One', headline: 'One', narration: 'A line.', footage: [], visual: { kind: 'motion', points: ['Coffee', 'Quiet'] } }]
  const build = (title: string, logo?: { width: number; height: number }) =>
    buildProducerTimeline({
      project: createProject({ id: 'p_cards', name: title }),
      brief: { title, audience: '', goal: 'Try it', tone: 'Friendly', template: 'studio-dark', voice: 'af_heart', aspect: '16:9', source: 'idea' },
      scenes,
      footage: new Map(),
      voices: new Map(scenes.map((sc) => [sc.id, voice(`as_vo_${sc.id}`, sc.narration)])),
      brand: { name: 'LSI Media', colors: ['#0b1830', '#ff5a5f'], fonts: { headline: 'Montserrat', body: 'Inter' } },
      ...(logo ? { logo: { id: 'as_logo', kind: 'image' as const, name: 'Logo', src: '', ...logo } } : {}),
    })
  const item = (p: ReturnType<typeof build>, name: string) => p.tracks.flatMap((t) => t.items).find((i) => i.name === name) as TextItem

  it('counts the lines a heading wraps to', () => {
    expect(headingLines('Morning ritual', 120, 1536)).toBe(1)
    expect(headingLines('Start your morning right', 120, 1536)).toBe(2)
    expect(headingLines('A very long title that goes on and on and on and on and on and on and on and on', 120, 1536)).toBe(3)
    expect(headingLines('', 120, 1536)).toBe(1)
  })

  it('moves a title of two lines up by half a line, so the name under it is never covered (seen 23 Nov)', () => {
    const one = build('Morning ritual')
    const two = build('Start your morning right')
    expect(item(one, 'Title').transform.y).toBe(-30)
    const lh = 120 * 1.05
    expect(item(two, 'Title').transform.y).toBeCloseTo(-30 - lh / 2, 0)
    // its last line ends where a one-line title's does; the name stays put, under it
    expect(item(two, 'Title').transform.y + lh).toBeCloseTo(item(one, 'Title').transform.y + lh / 2, 0)
    expect(item(two, 'Title label').transform.y).toBe(90)
    expect((item(two, 'Title label') as TextItem).text).toBe('LSI Media')
  })

  it('keeps the logo above a title of several lines, and on the frame', () => {
    const two = build('Start your morning right', { width: 400, height: 200 })
    const logo = item(two, "Title logo") as unknown as ImageItem
    const title = item(two, 'Title')
    const lh = 120 * 1.05
    const fit = Math.min(1920 / 400, 1080 / 200)
    const h = 200 * fit * logo.transform.scale
    expect(logo.transform.y + h / 2).toBeLessThan(title.transform.y - lh)
    expect(logo.transform.y - h / 2).toBeGreaterThan(-540)
    const three = build('A very long title that goes on and on and on and on and on and on and on and on', { width: 400, height: 200 })
    const top = item(three, "Title logo") as unknown as ImageItem
    expect(top.transform.y - (200 * fit * top.transform.scale) / 2).toBeGreaterThanOrEqual(-540)
  })

  it('reveals each point where it stands, so it never passes over its dot', () => {
    const f = { start: 0, duration: 6, voiceStart: 0.5, voiceDuration: 4, words: [], width: 1920, height: 1080, pal: lookPalette(getLook('studio-dark')) }
    const items = motionItems(['Coffee', 'Quiet'], f).map((p) => p.item)
    const words = items.filter((i) => i.type === 'text') as TextItem[]
    expect(words.map((w) => w.text)).toEqual(['Coffee', 'Quiet'])
    for (const w of words) expect(w.animations?.in?.preset).toBe('wipeRight')
    const dot = items.find((i) => i.name === "Point 1 marker") as TextItem
    expect(dot.transform.x).toBeLessThan(words[0].transform.x - words[0].style.boxWidth / 2)
  })
})
