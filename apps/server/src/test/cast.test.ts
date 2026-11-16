// One film, the same characters in every clip. The script's cast (who returns, and how each looks) is said word for
// word in every picture and clip that shows a character; where the clip model takes reference pictures, one picture of
// each character is painted once, kept with the project, and sent with every clip the character is in. Fake Gemini
// clients (no network); the clips and pictures are real files so the rest of the assembly is real.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { AI_LOOKS, type ProjectDocResponse, type ScriptCharacter, type ScriptScene } from '@producer/core'
import sharp from 'sharp'
import { MAX_CAST, MAX_REFERENCED, castIn, characterPicturePrompt, normalizeCast, sizesLine, tallAs, withCast } from '../ai/cast'
import { chartLayout, sizeChart } from '../media/size-chart'
import { setKeyClients } from '../ai/keys'
import { saveOnLatest } from '../ai/produce'
import { setGenerateClients } from '../ai/generate/capabilities'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { getJob } from '../jobs/queue'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { type Client, produceAssembleHere, setup, signup, type TestEnv } from './helpers'

const fox: ScriptCharacter = { name: 'the small orange fox', look: 'A young red fox cub, knee-high, bright orange fur, white chest and tail tip, black legs, large amber eyes.' }
const bird: ScriptCharacter = { name: 'the tiny blue bird', look: 'A round bluebird no bigger than the fox’s ear, sky-blue feathers, a short orange beak, black bead eyes.' }
const owl: ScriptCharacter = { name: 'the old owl', look: 'A grey owl with round spectacles.' }

describe('the cast, in words', () => {
  it('tidies what the writer gave: named characters with a look, none twice, a few at most', () => {
    expect(normalizeCast(undefined)).toEqual([])
    expect(normalizeCast('fox')).toEqual([])
    expect(
      normalizeCast([
        { name: '  the small   orange fox ', look: ` A young red fox cub,\n knee-high. ` },
        { name: 'The Small Orange Fox', look: 'again' },
        { name: 'no look', look: '  ' },
        { name: '', look: 'no name' },
        null,
        bird,
      ]),
    ).toEqual([{ name: 'the small orange fox', look: 'A young red fox cub, knee-high.' }, bird])
    expect(normalizeCast(Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, look: 'x' })))).toHaveLength(MAX_CAST)
    expect(normalizeCast([{ name: 'n'.repeat(200), look: 'l'.repeat(900) }])[0]).toEqual({ name: 'n'.repeat(80), look: 'l'.repeat(500) })
  })

  it('knows which characters a scene shows: by their name, or by its last word', () => {
    const cast = [fox, bird, owl]
    expect(castIn('The small orange fox walks through the forest.', cast)).toEqual([fox])
    expect(castIn('The fox curls round the bird beneath an oak; rain pours.', cast)).toEqual([fox, bird])
    expect(castIn('A golden sunset over quiet hills.', cast)).toEqual([])
    // whole words only, whatever the case and punctuation
    expect(castIn('Foxgloves sway; a BIRD, tiny, lands.', cast)).toEqual([bird])
    expect(castIn('anything', [])).toEqual([])
  })

  it('says each character’s look the same way in every prompt, and which reference picture shows it', () => {
    expect(withCast('The fox walks.', [])).toBe('The fox walks.')
    const words = withCast('  The fox meets the bird.  ', [fox, bird])
    expect(words).toBe(`The fox meets the bird.

The characters, the same in every shot of this film (keep each one's design exactly as described; never redesign them):
- the small orange fox: ${fox.look}
- the tiny blue bird: ${bird.look}`)
    const pictured = withCast('The fox meets the bird and the owl.', [fox, bird, owl], 2)
    expect(pictured).toContain(`- the small orange fox: ${fox.look} (shown in reference picture 1)`)
    expect(pictured).toContain(`- the tiny blue bird: ${bird.look} (shown in reference picture 2)`)
    expect(pictured).toContain(`- the old owl: ${owl.look}\n`)
    expect(pictured).toContain('and as its reference picture shows')
    expect(pictured).toMatch(/do not copy their plain background, their pose or their framing\.$/)
    // the picture a character is painted from: it alone, whole, on a plain ground
    const sheet = characterPicturePrompt(fox)
    expect(sheet).toContain(`A reference picture of one character of a film: the small orange fox. ${fox.look}`)
    expect(sheet).toMatch(/whole character from head to foot, alone/)
    expect(sheet).toMatch(/plain light grey background/)
    expect(MAX_REFERENCED).toBe(2)
  })

  it('keeps how tall each character stands, and says how their sizes compare the same way in every prompt', () => {
    // a height that can be one is kept (rounded); anything else is left out and nothing is said about sizes
    expect(normalizeCast([{ ...fox, heightCm: 30.4 }, { ...bird, heightCm: 7.96 }, { ...owl, heightCm: 'tall' }, { name: 'a giant', look: 'x', heightCm: 99_999 }, { name: 'a speck', look: 'x', heightCm: 0 }])).toEqual([
      { ...fox, heightCm: 30 },
      { ...bird, heightCm: 8 },
      owl,
      { name: 'a giant', look: 'x' },
    ])
    expect([1, 0.75, 0.62, 0.5, 0.33, 8 / 30, 0.2, 0.16, 0.125, 0.1, 0.03].map(tallAs)).toEqual([
      'about as tall as',
      'about three quarters as tall as',
      'about two thirds as tall as',
      'about half as tall as',
      'about a third as tall as',
      'about a quarter as tall as',
      'about a fifth as tall as',
      'about a sixth as tall as',
      'about an eighth as tall as',
      'about a tenth as tall as',
      'less than a tenth as tall as',
    ])
    const tallFox = { ...fox, heightCm: 30 }
    const smallBird = { ...bird, heightCm: 8 }
    // whichever order they are named in, the taller one is the measure
    const line = sizesLine([smallBird, tallFox])
    expect(line).toBe(
      'Their sizes, the same in every shot (the small orange fox stands about 30 cm tall, the tiny blue bird stands about 8 cm tall): the tiny blue bird is about a quarter as tall as the small orange fox. Keep that difference in size in every shot, close-ups included: never enlarge a smaller character so that it reads better.',
    )
    expect(sizesLine([tallFox, smallBird], 3)).toBe(`${line} Reference picture 3 shows them side by side at these sizes.`)
    // one character, or heights unknown: nothing to compare
    expect(sizesLine([tallFox])).toBe('')
    expect(sizesLine([tallFox, bird])).toBe('')
    expect(sizesLine([{ name: 'Maya', look: 'x', heightCm: 165 }, { name: 'her son', look: 'x', heightCm: 100 }, { name: 'the cat', look: 'x', heightCm: 25 }])).toContain(
      '(Maya stands about 1.65 m tall, her son stands about 1 m tall, the cat stands about 25 cm tall): her son is about two thirds as tall as Maya; the cat is about a seventh as tall as Maya.',
    )
    // in a prompt it comes after the characters, before the note about the reference pictures
    const asked = withCast('The fox meets the bird.', [tallFox, smallBird], 2, 3)
    expect(asked.indexOf('- the tiny blue bird:')).toBeLessThan(asked.indexOf('Their sizes, the same in every shot'))
    expect(asked).toContain('Reference picture 3 shows them side by side at these sizes.\nThe reference pictures only show what the characters look like')
    // a cast written before heights were asked for reads exactly as it did
    expect(withCast('The fox meets the bird.', [fox, bird], 2)).not.toContain('Their sizes')
  })
})

describe('the characters side by side at their true sizes', () => {
  it('stands everyone on one line, each as tall as it really is beside the tallest', () => {
    // a fox 30 cm tall and a bird 8: pictures of 600 x 900 and 300 x 300 pixels
    const l = chartLayout([{ width: 600, height: 900 }, { width: 300, height: 300 }], [30, 8])
    expect(l.placed[0]).toEqual({ left: 72, top: 72, width: 587, height: 880 })
    // 8 / 30 of 880, standing on the same line (bottoms equal)
    expect(l.placed[1]).toMatchObject({ width: 235, height: 235, left: 72 + 587 + 96 })
    expect(l.placed[1].top + l.placed[1].height).toBe(l.placed[0].top + l.placed[0].height)
    expect(l).toMatchObject({ height: 880 + 144, width: 72 + 587 + 96 + 235 + 72 })
    // the order given is kept, whoever is taller; a very small one is still there to be seen
    const m = chartLayout([{ width: 100, height: 100 }, { width: 400, height: 800 }], [1, 200])
    expect(m.placed[0].height).toBe(28)
    expect(m.placed[1].height).toBe(880)
    expect(m.placed[0].left).toBeLessThan(m.placed[1].left)
    // a long row is scaled down whole, proportions kept
    const wide = chartLayout([{ width: 3000, height: 900 }, { width: 3000, height: 900 }], [10, 5])
    expect(wide.width).toBeLessThanOrEqual(2600)
    expect(wide.placed[1].height / wide.placed[0].height).toBeCloseTo(0.5, 1)
  })

  it('cuts each character out of its own picture and writes one picture of them all', async () => {
    const t = await setup()
    const dir = path.join(t.dataDir, 'size-chart')
    fs.mkdirSync(dir, { recursive: true })
    const grey = { r: 217, g: 217, b: 217 }
    // each character fills its own picture the same way: an orange "fox" 300 x 600 and a blue "bird" 300 x 300, on grey
    const picture = async (name: string, w: number, h: number, colour: { r: number; g: number; b: number }) => {
      const file = path.join(dir, name)
      await sharp({ create: { width: 1000, height: 1000, channels: 3, background: grey } })
        .composite([{ input: await sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer(), left: Math.round((1000 - w) / 2), top: Math.round((1000 - h) / 2) }])
        .png()
        .toFile(file)
      return file
    }
    const foxPic = await picture('fox.png', 300, 600, { r: 240, g: 120, b: 20 })
    const birdPic = await picture('bird.png', 300, 300, { r: 40, g: 110, b: 230 })
    const out = path.join(dir, 'sizes.jpg')
    await sizeChart([{ file: foxPic, heightCm: 30 }, { file: birdPic, heightCm: 8 }], out)
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('jpeg')
    // the fox cut to its 300 x 600 and drawn 880 high (440 wide), the bird 235 high: 72 + 440 + 96 + 235 + 72
    expect([meta.width, meta.height]).toEqual([915, 1024])
    const px = async (x: number, y: number) => [...(await sharp(out).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())]
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 30)
    // the ground is the pictures' own grey; the fox is orange from top to bottom of the row
    expect(near(await px(10, 10), [217, 217, 217])).toBe(true)
    expect(near(await px(72 + 220, 80), [240, 120, 20])).toBe(true)
    expect(near(await px(72 + 220, 72 + 870), [240, 120, 20])).toBe(true)
    // the bird stands on the same line and reaches only a quarter of the way up: blue low down, grey above it
    const birdX = 72 + 440 + 96 + 117
    expect(near(await px(birdX, 72 + 880 - 100), [40, 110, 230])).toBe(true)
    expect(near(await px(birdX, 72 + 880 - 300), [217, 217, 217])).toBe(true)
    // a picture with nothing to cut away (one colour) is used whole rather than failing the chart
    const flat = path.join(dir, 'flat.png')
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toFile(flat)
    await sizeChart([{ file: foxPic, heightCm: 30 }, { file: flat, heightCm: 15 }], path.join(dir, 'sizes-2.jpg'))
    expect((await sharp(path.join(dir, 'sizes-2.jpg')).metadata()).height).toBe(1024)
  }, 120_000)
})

// ---------------------------------------------------------------- a film assembled with a cast

const GEMINI_KEY = 'AIzaSyCASTKEY0123456789abcdefg'
const gemini = { generateContent: vi.fn(), create: vi.fn(), get: vi.fn(), cancel: vi.fn(), delete: vi.fn() }
let t: TestEnv
let client: Client
let workspaceId = ''
let MP4: Buffer
let PNG: Buffer

beforeAll(async () => {
  t = await setup()
  const made = path.join(t.dataDir, 'cast-fixtures')
  fs.mkdirSync(made, { recursive: true })
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=orange:s=320x180:r=30', '-t', '2', '-pix_fmt', 'yuv420p', path.join(made, 'clip.mp4')])
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', path.join(made, 'pic.png')])
  MP4 = fs.readFileSync(path.join(made, 'clip.mp4'))
  PNG = fs.readFileSync(path.join(made, 'pic.png'))
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
  const u = await signup(t.app, 'Film maker')
  client = u.client
  workspaceId = u.workspaceId
  expect((await client.json('PUT', '/api/ai/keys/gemini', { workspaceId, key: GEMINI_KEY })).status).toBe(200)
}, 120_000)
afterAll(() => {
  setKeyClients(undefined)
  setGenerateClients(undefined)
})
beforeEach(() => {
  for (const f of Object.values(gemini)) f.mockReset()
  gemini.cancel.mockResolvedValue({})
  gemini.delete.mockResolvedValue(undefined)
  // a picture for every character asked for, a finished clip for every clip asked for
  gemini.generateContent.mockImplementation(async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] }, finishReason: 'STOP' }] }))
  let n = 0
  gemini.create.mockImplementation(async () => ({ id: `int-${++n}`, status: 'completed', output_video: { data: MP4.toString('base64'), mime_type: 'video/mp4' } }))
  ctx().config.freeMedia = false
  setGenerateClients({
    openai: () => ({ images: { generate: vi.fn() } }),
    gemini: () => ({ models: { generateContent: gemini.generateContent }, interactions: { create: gemini.create, get: gemini.get, cancel: gemini.cancel, delete: gemini.delete } }),
    fetch: vi.fn() as unknown as typeof fetch,
    probe: async (file: string) => (file.endsWith('.mp4') ? { duration: 2, width: 320, height: 180 } : { width: 64, height: 64 }),
    now: () => Date.now(),
    sleep: async () => undefined,
  } as never)
})

const brief = { title: 'A friend in every season', audience: '', goal: '', tone: 'Calm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const, source: 'idea' as const, idea: 'A fox and a bird', lengthSec: 30, motion: 'full' as const, aiLook: 'animated3d', visualKinds: ['aiVideo' as const], narration: false, captions: false, onScreenText: false, cards: false, music: 'off', soundEffects: false }
const clip = (id: string, narration: string, prompt: string): ScriptScene => ({ id, title: id, headline: '', narration, footage: [], visual: { kind: 'aiVideo', prompt } })
const film: ScriptScene[] = [
  clip('s01', 'A fox finds a sad bird beneath a tree.', 'The small orange fox walks a sunlit forest and spots the tiny blue bird under a tree; slow push-in.'),
  clip('s02', 'Rain pours; the fox shelters the bird.', 'Heavy rain; the fox curls beneath an oak, sheltering the bird; the old owl watches from a branch.'),
  clip('s03', 'The fox trots on alone.', 'The fox trots through wet ferns, shaking off the rain; tracking shot.'),
  clip('s04', 'A golden sunset over the hills.', 'A golden sunset over quiet hills; the camera slowly pulls back.'),
]

async function newFilm(cast: ScriptCharacter[] | undefined, name: string) {
  const r = await client.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId, name, kind: 'producer', width: 1920, height: 1080 })
  expect(r.status).toBe(200)
  const id = r.body.project.id
  // the script as the writer leaves it: scenes and, when it named one, the cast
  await saveOnLatest(id, (cur) => ({ ...cur, ai: { ...(cur.ai ?? {}), brief, script: { scenes: film, ...(cast ? { cast } : {}) }, status: 'scripted' } }))
  return id
}
async function assemble(id: string, scenes: ScriptScene[] = film) {
  const r = await client.json('POST', '/api/ai/produce/assemble', { projectId: id, scenes, brief })
  expect(r.status).toBe(200)
  const job = (await getJob(r.body.id))!
  const out = await produceAssembleHere(inlineContext({ id: job.id, kind: 'ai.produce.assemble', workspaceId, userId: job.userId, projectId: id, input: job.input }))
  return { out, p: (await client.json<ProjectDocResponse>('GET', `/api/projects/${id}`)).body.project }
}
type Part = { type: string; text?: string; data?: string; mime_type?: string }
const bodies = () => gemini.create.mock.calls.map((c) => c[0] as { input: string | Part[]; generation_config?: unknown })
const textOf = (b: { input: string | Part[] }) => (typeof b.input === 'string' ? b.input : (b.input.find((p) => p.type === 'text')?.text ?? ''))
const picturesOf = (b: { input: string | Part[] }) => (typeof b.input === 'string' ? [] : b.input.filter((p) => p.type === 'image'))
const LOOK = AI_LOOKS.find((l) => l.id === 'animated3d')!.prompt

describe('a film assembled with a cast', () => {
  it('paints each returning character once and sends its picture, and its look in words, with every clip it is in', async () => {
    const id = await newFilm([fox, bird, owl], 'Fox film')
    const { out, p } = await assemble(id)
    expect(out.notes ?? []).toEqual([])
    // four clips on the timeline (the 2 s test clips are shorter than their scenes, so each is used more than once)
    expect(new Set(p.tracks.find((tr) => tr.main)!.items.filter((i) => i.type === 'video').map((i) => (i as { assetId?: string }).assetId)).size).toBe(4)

    // two pictures were painted: the fox (three clips) and the bird (two); the owl is in one clip only, so its words do
    const painted = gemini.generateContent.mock.calls.map((c) => JSON.stringify(c[0]))
    expect(painted).toHaveLength(2)
    expect(painted[0]).toContain('A reference picture of one character of a film: the small orange fox.')
    expect(painted[1]).toContain('A reference picture of one character of a film: the tiny blue bird.')
    // in the film's look, like the clips
    expect(painted.every((x) => x.includes(JSON.stringify(LOOK).slice(1, -1)))).toBe(true)

    const sent = bodies()
    expect(sent).toHaveLength(4)
    // s01: the fox and the bird: both pictures, then the words, and the task that says they are references
    expect(picturesOf(sent[0])).toEqual([
      { type: 'image', data: PNG.toString('base64'), mime_type: 'image/png' },
      { type: 'image', data: PNG.toString('base64'), mime_type: 'image/png' },
    ])
    expect(sent[0].generation_config).toEqual({ video_config: { task: 'reference_to_video' } })
    expect(textOf(sent[0])).toContain('The small orange fox walks a sunlit forest')
    expect(textOf(sent[0])).toContain(`Visual style: ${LOOK}`)
    expect(textOf(sent[0])).toContain(`- the small orange fox: ${fox.look} (shown in reference picture 1)`)
    expect(textOf(sent[0])).toContain(`- the tiny blue bird: ${bird.look} (shown in reference picture 2)`)
    // s02: called "the fox" and "the bird" there; the owl has no picture and is described last
    expect(picturesOf(sent[1])).toHaveLength(2)
    expect(textOf(sent[1])).toContain(`- the old owl: ${owl.look}\n`)
    expect(textOf(sent[1]).indexOf('the tiny blue bird:')).toBeLessThan(textOf(sent[1]).indexOf('the old owl:'))
    // s03: the fox alone: its picture only
    expect(picturesOf(sent[2])).toHaveLength(1)
    expect(textOf(sent[2])).toContain('(shown in reference picture 1)')
    expect(textOf(sent[2])).not.toContain('the tiny blue bird')
    // s04: nobody in it: the words as they were, and no pictures
    expect(sent[3].input).toBe(`A golden sunset over quiet hills; the camera slowly pulls back.\n\nVisual style: ${LOOK}`)
    expect(sent[3].generation_config).toBeUndefined()

    // the pictures are kept with the project, named for whom they show
    const kept = (await ctx().db.select().from(assets).where(eq(assets.projectId, id))).filter((r) => r.meta?.generated?.kind === 'character')
    expect(kept.map((r) => [r.name, r.kind, r.status]).sort()).toEqual([
      ['Character · the small orange fox', 'image', 'ready'],
      ['Character · the tiny blue bird', 'image', 'ready'],
    ])

    // assembled again as it is: the same clips and the same pictures, nothing made twice
    gemini.generateContent.mockClear()
    gemini.create.mockClear()
    const again = await assemble(id, p.ai!.script!.scenes)
    expect(gemini.generateContent).not.toHaveBeenCalled()
    expect(gemini.create).not.toHaveBeenCalled()
    expect(again.p.ai!.script!.scenes.map((s) => (s.visual as { assetId?: string }).assetId)).toEqual(p.ai!.script!.scenes.map((s) => (s.visual as { assetId?: string }).assetId))
    // and the cast is still on the script (an assembly, or the wizard saving a draft, never drops it)
    expect(again.p.ai!.script!.cast).toEqual([fox, bird, owl])
    expect((await client.json('PUT', '/api/ai/produce/draft', { projectId: id, brief, scenes: again.p.ai!.script!.scenes })).status).toBe(200)
    expect((await client.json<ProjectDocResponse>('GET', `/api/projects/${id}`)).body.project.ai!.script!.cast).toEqual([fox, bird, owl])
  }, 240_000)

  it('a cast with heights: clips that show both characters also get them side by side at their true sizes, and the words say so', async () => {
    const id = await newFilm([{ ...fox, heightCm: 30 }, { ...bird, heightCm: 8 }], 'Fox film, sized')
    const { out } = await assemble(id)
    expect(out.notes ?? []).toEqual([])
    const sent = bodies()
    expect(sent).toHaveLength(4)
    // s01 and s02 show both: the fox's picture, the bird's, then the chart made from the two (a JPEG; theirs are PNGs)
    for (const b of sent.slice(0, 2)) {
      const pics = picturesOf(b)
      expect(pics.map((p) => p.mime_type)).toEqual(['image/png', 'image/png', 'image/jpeg'])
      expect(pics[2].data).not.toBe(pics[0].data)
      expect(textOf(b)).toContain('the tiny blue bird is about a quarter as tall as the small orange fox.')
      expect(textOf(b)).toContain('Reference picture 3 shows them side by side at these sizes.')
      expect(b.generation_config).toEqual({ video_config: { task: 'reference_to_video' } })
    }
    // the chart is a real picture of the two (the test pictures are one colour, so each is used whole: 880 and 235 high)
    const chart = await sharp(Buffer.from(picturesOf(sent[0])[2].data!, 'base64')).metadata()
    expect([chart.format, chart.width, chart.height]).toEqual(['jpeg', 72 + 880 + 96 + 235 + 72, 1024])
    // s03, the fox alone: its picture, and nothing about sizes
    expect(picturesOf(sent[2])).toHaveLength(1)
    expect(textOf(sent[2])).not.toContain('Their sizes')
    // the chart is made from the pictures, not painted: two pictures were asked of the image model, no more
    expect(gemini.generateContent).toHaveBeenCalledTimes(2)
    // nothing is added to the Library for it
    const kept = (await ctx().db.select().from(assets).where(eq(assets.projectId, id))).filter((r) => r.kind === 'image')
    expect(kept.map((r) => r.name).sort()).toEqual(['Character · the small orange fox', 'Character · the tiny blue bird'])
  }, 240_000)

  it('a picture that can’t be painted leaves that character to the words, and says so; no cast: clips as before', async () => {
    // Google declines every picture
    gemini.generateContent.mockImplementation(async () => ({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }))
    const id = await newFilm([fox, bird], 'Fox film, no pictures')
    const { out } = await assemble(id)
    expect(out.notes).toEqual([
      'the small orange fox may look different from clip to clip: its reference picture couldn’t be painted (Gemini declined to make this image (its content rules). Try describing the scene differently.)',
      'the tiny blue bird may look different from clip to clip: its reference picture couldn’t be painted (Gemini declined to make this image (its content rules). Try describing the scene differently.)',
    ])
    const sent = bodies()
    expect(sent).toHaveLength(4)
    // every clip is still made, from words that describe the characters the same way each time
    expect(sent.every((b) => typeof b.input === 'string' && b.generation_config === undefined)).toBe(true)
    expect(textOf(sent[0])).toContain(`- the small orange fox: ${fox.look}\n- the tiny blue bird: ${bird.look}`)
    expect(textOf(sent[0])).not.toContain('reference picture')

    // a script with no cast (written before there was one): exactly the request it always was
    gemini.create.mockClear()
    gemini.generateContent.mockClear()
    const plain = await assemble(await newFilm(undefined, 'Fox film, no cast'))
    expect(plain.out.notes ?? []).toEqual([])
    expect(gemini.generateContent).not.toHaveBeenCalled()
    expect(bodies().map((b) => b.input)).toEqual(film.map((s) => `${(s.visual as { prompt: string }).prompt}\n\nVisual style: ${LOOK}`))
  }, 240_000)
})
