// Videos made from an idea: the writer's scene format, reveal timing, diagram/motion layouts and the timeline.
import { beforeAll, describe, expect, it } from 'vitest'
import { AI_LOOKS, createProject, evaluate, withAiLook, itemEnd, projectDuration, type Asset, type Project, type ScriptScene, type VisualKind } from '@producer/core'
import { buildProducerTimeline, firstFramePrompt, syntheticTranscript } from '../ai/produce'
import { type IdeaMedia, type IdeaScriptOutput, VisualSchema, buildIdeaPrompt, normalizeIdeaScript } from '../ai/scenes'
import { diagramItems, revealTimes, type SceneFrame } from '../ai/scene-layout'
import { type Palette, getLook, lookPalette } from '../services/looks'
import { setup } from './helpers'

let pal: Palette
beforeAll(async () => {
  await setup()
  pal = lookPalette(getLook('studio-dark'))
})

type FlatVisual = IdeaScriptOutput['scenes'][number]['visual']
const blank: FlatVisual = { kind: 'motion', points: [], diagramType: 'none', items: [], details: [], values: [], unit: '', center: '', leftTitle: '', leftPoints: [], rightTitle: '', rightPoints: [], prompt: '', query: '', mediaId: '', animStyle: 'none', objects: [], labels: [] }
const scene = (visual: Partial<FlatVisual>, narration = 'We plan, then build, then ship it.') => ({ id: 'x', title: 'T', headline: 'Head', narration, visual: { ...blank, ...visual } })

describe("the writer's scenes", () => {
  it('turns flat visuals into scene visuals, and anything unusable into animated text', () => {
    const out: IdeaScriptOutput = {
      message: 'm',
      scenes: [
        scene({ kind: 'motion', points: ['One', ' Two ', ''] }),
        scene({ kind: 'diagram', diagramType: 'steps', items: ['Plan', 'Build', 'Ship'] }),
        scene({ kind: 'diagram', diagramType: 'bars', items: ['A', 'B', 'C'], values: [3, 5], unit: '%' }),
        scene({ kind: 'diagram', diagramType: 'steps', items: ['Only one'] }),
        scene({ kind: 'image', prompt: 'A lighthouse at dusk' }),
        scene({ kind: 'aiVideo', prompt: 'Drone over a forest' }),
        scene({ kind: 'stock', query: '' }),
        scene({ kind: 'motion' }, '   '),
      ],
    }
    const scenes = normalizeIdeaScript(out, ['motion', 'diagram', 'image', 'stock'])
    expect(scenes.map((s) => s.id)).toEqual(['s01', 's02', 's03', 's04', 's05', 's06', 's07'])
    expect(scenes[0].visual).toEqual({ kind: 'motion', points: ['One', 'Two'] })
    expect(scenes[1].visual).toEqual({ kind: 'diagram', diagram: { type: 'steps', items: ['Plan', 'Build', 'Ship'] } })
    // bars keep only label/value pairs that both exist
    expect(scenes[2].visual).toEqual({ kind: 'diagram', diagram: { type: 'bars', items: [{ label: 'A', value: 3 }, { label: 'B', value: 5 }], unit: '%' } })
    // a one-step "steps" can't be drawn; aiVideo isn't allowed here; an empty stock query has nothing to search
    expect(scenes[3].visual?.kind).toBe('motion')
    expect(scenes[4].visual).toEqual({ kind: 'image', prompt: 'A lighthouse at dusk' })
    expect(scenes[5].visual?.kind).toBe('motion')
    expect(scenes[6].visual?.kind).toBe('motion')
    for (const s of scenes) expect(VisualSchema.safeParse(s.visual).success).toBe(true)
  })

  it('turns a scene showing your own media into that clip or image, and an unknown one into animated text', () => {
    const media: IdeaMedia[] = [
      { ref: 'm1', assetId: 'as_beach', kind: 'video', name: 'beach.mp4', duration: 12 },
      { ref: 'm2', assetId: 'as_team', kind: 'image', name: 'team.jpg' },
    ]
    const out: IdeaScriptOutput = { message: 'm', scenes: [scene({ kind: 'media', mediaId: 'M2' }), scene({ kind: 'media', mediaId: 'm1' }), scene({ kind: 'media', mediaId: 'm9' })] }
    const scenes = normalizeIdeaScript(out, ['motion', 'media'], media)
    expect(scenes.map((s) => s.visual)).toEqual([
      { kind: 'media', assetId: 'as_team' },
      { kind: 'media', assetId: 'as_beach' },
      { kind: 'motion', points: ['Head'] },
    ])
    // with no media offered, a media scene can't be drawn
    expect(normalizeIdeaScript(out, ['motion'], media)[0].visual?.kind).toBe('motion')
  })

  it('lists your media for the writer only when there is some', () => {
    const brief = { title: 'Trip', audience: '', goal: '', tone: 'warm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const, source: 'idea' as const, idea: 'Our team trip' }
    const media: IdeaMedia[] = [
      { ref: 'm1', assetId: 'as_beach', kind: 'video', name: 'beach "day".mp4', duration: 12.4, speech: 'Welcome   to the beach' },
      { ref: 'm2', assetId: 'as_team', kind: 'image', name: 'team.jpg' },
    ]
    const withMedia = buildIdeaPrompt({ brief, kinds: ['motion', 'media'], rules: '', example: '', media })
    expect(withMedia).toContain('YOUR MEDIA')
    expect(withMedia).toContain(`- m1 · video clip, 12 s · "beach 'day'.mp4" · says: "Welcome to the beach"`)
    expect(withMedia).toContain('- m2 · image · "team.jpg"')
    expect(withMedia).toContain('- media:')
    const without = buildIdeaPrompt({ brief, kinds: ['motion', 'media'], rules: '', example: '' })
    expect(without).not.toContain('YOUR MEDIA')
    expect(without).not.toContain('- media:')
    expect(without).toContain('There are no recordings')
  })

  it('full motion: every scene a clip, scenes as long as a clip, more of them; a look keeps style out of the prompts', () => {
    const brief = { title: 'Fox', audience: '', goal: '', tone: 'warm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const, source: 'idea' as const, idea: 'A fox finds its way home', lengthSec: 60 }
    const kinds: VisualKind[] = ['motion', 'diagram', 'image', 'aiVideo']
    const plain = buildIdeaPrompt({ brief, kinds, rules: '', example: '' })
    expect(plain).toContain('use for at most 2 scenes')
    expect(plain).not.toContain('FULL MOTION')
    expect(plain).toContain('About 7 scenes')
    // the same person, place or thing is described in the same words in every generated picture and clip
    expect(plain).toContain('Continuity:')
    const full = buildIdeaPrompt({ brief: { ...brief, motion: 'full' }, kinds, rules: '', example: '' })
    expect(full).toContain('FULL MOTION: this is an animated film. Make EVERY scene an aiVideo')
    expect(full).toContain('About 8 scenes')
    expect(full).toContain('narration 12-24 words per scene')
    expect(full).not.toContain('use for at most 2 scenes')
    // full motion needs clips to be on offer
    expect(buildIdeaPrompt({ brief: { ...brief, motion: 'full' }, kinds: ['motion'], rules: '', example: '' })).not.toContain('FULL MOTION')
    const look = buildIdeaPrompt({ brief: { ...brief, aiLook: 'claymation' }, kinds, rules: '', example: '' })
    expect(look).toContain('the video’s look (Claymation) is added to every picture and clip')
    expect(look).not.toContain('(subject, setting, light, style)')
    expect(buildIdeaPrompt({ brief: { ...brief, aiLook: 'nonsense' }, kinds, rules: '', example: '' })).not.toContain('video’s look')
    expect(buildIdeaPrompt({ brief, kinds: ['motion', 'diagram'], rules: '', example: '' })).not.toContain('Continuity:')
  })

  it('adds the look to every generated prompt, and nothing for automatic', () => {
    expect(withAiLook('A fox in snow', 'claymation')).toBe(`A fox in snow\n\nVisual style: ${AI_LOOKS.find((l) => l.id === 'claymation')!.prompt}`)
    expect(withAiLook('A fox in snow', 'auto')).toBe('A fox in snow')
    expect(withAiLook('A fox in snow', undefined)).toBe('A fox in snow')
    expect(withAiLook('A fox in snow', 'made-up')).toBe('A fox in snow')
    expect(firstFramePrompt('A fox runs')).toMatch(/^The opening frame of this shot, as one finished still picture[\s\S]*A fox runs$/)
  })

  it('refuses visuals the API must not store', () => {
    expect(VisualSchema.safeParse({ kind: 'diagram', diagram: { type: 'steps', items: Array(9).fill('x') } }).success).toBe(false)
    expect(VisualSchema.safeParse({ kind: 'stock', query: 'city', credit: { author: 'A', url: 'javascript:alert(1)' } }).success).toBe(false)
    expect(VisualSchema.safeParse({ kind: 'teleport' }).success).toBe(false)
    expect(VisualSchema.safeParse({ kind: 'media' }).success).toBe(false)
    expect(VisualSchema.safeParse({ kind: 'media', assetId: 'as_1', start: -2 }).success).toBe(false)
    expect(VisualSchema.safeParse({ kind: 'media', assetId: 'as_1', start: 2, end: 6 }).success).toBe(true)
  })
})

const frame = (over: Partial<SceneFrame> = {}): SceneFrame => ({ start: 10, duration: 8, voiceStart: 10.5, voiceDuration: 6, words: [], width: 1920, height: 1080, pal, ...over })

describe('reveal timing', () => {
  it('shows each part as the narration says it, in order, and never too early or bunched', () => {
    const words = [
      { w: 'First', start: 0.2 },
      { w: 'we', start: 0.6 },
      { w: 'plan,', start: 0.9 },
      { w: 'then', start: 2.0 },
      { w: 'we', start: 2.3 },
      { w: 'build.', start: 2.6 },
      { w: 'Shipping', start: 4.1 },
      { w: 'follows.', start: 4.6 },
    ]
    const t = revealTimes(['Plan', 'Build', 'Ship it'], frame({ words }))
    expect(t[0]).toBeCloseTo(10.5 + 0.9 - 0.15, 2)
    expect(t[1]).toBeCloseTo(10.5 + 2.6 - 0.15, 2)
    // "Shipping" matches "Ship" only as a whole word; "ship" (4 letters) isn't prefix-matched, so it falls back evenly
    expect(t[2]).toBeGreaterThan(t[1] + 0.3)
    expect(t.every((x) => x >= 10.6 && x <= 10 + 8 - 1.2)).toBe(true)
  })

  it('spreads parts evenly when the words never come up', () => {
    const t = revealTimes(['Alpha', 'Beta', 'Gamma', 'Delta'], frame())
    for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeGreaterThanOrEqual(0.35)
  })
})

describe('diagram layouts', () => {
  const all = [
    { type: 'steps', items: ['Plan', 'Build', 'Test', 'Ship'] },
    { type: 'cycle', items: ['Listen', 'Learn', 'Change'] },
    { type: 'hub', center: 'Platform', items: ['Data', 'Apps', 'People', 'Rules'] },
    { type: 'bars', items: [{ label: '2024', value: 40 }, { label: '2025', value: 65 }, { label: '2026', value: 90 }], unit: '%' },
    { type: 'compare', left: { title: 'Before', points: ['Manual', 'Slow'] }, right: { title: 'After', points: ['Automatic', 'Fast'] } },
    { type: 'timeline', items: [{ label: 'Jan', detail: 'Kickoff' }, { label: 'Mar' }, { label: 'Jun', detail: 'Launch' }] },
    { type: 'stat', value: '3x', label: 'faster onboarding' },
  ] as const
  for (const aspect of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) {
    it(`every diagram stays on a ${aspect.width}x${aspect.height} canvas and inside its scene`, () => {
      for (const d of all) {
        const f = frame(aspect)
        const placed = diagramItems(d as never, f)
        expect(placed.length, d.type).toBeGreaterThan(0)
        for (const { item } of placed) {
          expect(item.start, d.type).toBeGreaterThanOrEqual(f.start)
          expect(itemEnd(item), d.type).toBeLessThanOrEqual(f.start + f.duration + 1e-6)
          const tr = (item as { transform: { x: number; y: number } }).transform
          expect(Math.abs(tr.x), `${d.type} x`).toBeLessThanOrEqual(aspect.width / 2)
          expect(Math.abs(tr.y), `${d.type} y`).toBeLessThanOrEqual(aspect.height / 2)
          // clear of the captions along the bottom (their band starts about a third of the height below the centre)
          const half = item.type === 'shape' ? (item as { height: number }).height / 2 : item.type === 'text' ? (item as { style: { fontSize: number } }).style.fontSize * 0.6 : 0
          // (the soft background glows are meant to bleed off the frame)
          if (item.name !== 'Glow') expect(tr.y + half, `${d.type} bottom`).toBeLessThanOrEqual(aspect.height * (aspect.height > aspect.width ? 0.34 : 0.33))
        }
      }
    })
  }
})

describe('timeline from an idea', () => {
  const voice = (id: string, text: string): { asset: Asset; duration: number } => ({ asset: { id, kind: 'audio', name: id, src: '', duration: 4, transcript: syntheticTranscript(text, 4) }, duration: 4 })
  const still: Asset = { id: 'as_img', kind: 'image', name: 'lighthouse', src: '', width: 1536, height: 1024 }
  const clip: Asset = { id: 'as_clip', kind: 'video', name: 'city', src: '', duration: 6, width: 1920, height: 1080, hasAudio: false }
  const scenes: ScriptScene[] = [
    { id: 's01', title: 'Hook', headline: 'Ship faster', narration: 'Ship faster with less stress.', footage: [], visual: { kind: 'motion', points: ['Less waiting', 'Fewer handoffs', 'Clear owners'] } },
    { id: 's02', title: 'How', headline: 'Three steps', narration: 'Plan, build, then ship.', footage: [], visual: { kind: 'diagram', diagram: { type: 'steps', items: ['Plan', 'Build', 'Ship'] } } },
    { id: 's03', title: 'Why', headline: 'Calm teams', narration: 'Calm teams do better work.', footage: [], visual: { kind: 'image', prompt: 'calm office', assetId: 'as_img' } },
    { id: 's04', title: 'Where', headline: 'Everywhere', narration: 'It works in any city.', footage: [], visual: { kind: 'stock', query: 'city', assetId: 'as_clip' } },
    { id: 's05', title: 'Close', headline: 'Start today', narration: 'Start today.', footage: [], visual: { kind: 'diagram', diagram: { type: 'stat', value: '3x', label: 'faster' } } },
  ]
  let p: Project
  beforeAll(() => {
    p = buildProducerTimeline({
    project: createProject({ id: 'p_idea', name: 'Idea' }),
    brief: { title: 'Idea', audience: 'Teams', goal: 'Ship', tone: 'warm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9', source: 'idea' },
    scenes,
    footage: new Map(),
    voices: new Map(scenes.map((s) => [s.id, voice(`as_vo_${s.id}`, s.narration)])),
    generated: new Map([
      ['s03', still],
      ['s04', clip],
    ]),
    })
  })

  it('puts your own image (with a slow pan) and your own clip (from the part chosen, filling the frame) on the main track', () => {
    const photo: Asset = { id: 'as_photo', kind: 'image', name: 'team.jpg', src: '', width: 1200, height: 900 }
    const beach: Asset = { id: 'as_beach', kind: 'video', name: 'beach.mp4', src: '', duration: 20, width: 1920, height: 1080, hasAudio: true }
    const own: ScriptScene[] = [
      { id: 's01', title: 'Team', headline: 'Our team', narration: 'This is our team.', footage: [], visual: { kind: 'media', assetId: 'as_photo' } },
      { id: 's02', title: 'Beach', headline: 'The beach', narration: 'And this is where we went.', footage: [], visual: { kind: 'media', assetId: 'as_beach', start: 5 } },
      { id: 's03', title: 'Gone', headline: 'Gone', narration: 'A clip that was deleted.', footage: [], visual: { kind: 'media', assetId: 'as_missing' } },
    ]
    const q = buildProducerTimeline({
      project: createProject({ id: 'p_own', name: 'Own' }),
      brief: { title: 'Own', audience: '', goal: '', tone: 'warm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9', source: 'idea' },
      scenes: own,
      footage: new Map([
        ['as_photo', photo],
        ['as_beach', beach],
      ]),
      voices: new Map(own.map((s) => [s.id, voice(`as_vo_${s.id}`, s.narration)])),
    })
    const main = q.tracks.find((t) => t.main)!
    const img = main.items.find((i) => i.type === 'image')!
    expect(img).toMatchObject({ assetId: 'as_photo', fit: 'cover' })
    expect((img as { effects: Array<{ type: string }> }).effects.map((e) => e.type)).toContain('kenBurns')
    const vid = main.items.filter((i) => i.type === 'video')
    expect(vid[0]).toMatchObject({ assetId: 'as_beach', fit: 'cover', in: 5, muted: true })
    expect(q.assets.as_photo).toBeDefined()
    expect(q.assets.as_beach).toBeDefined()
    // one that isn't in the space any more becomes a card, never a broken item
    expect(main.items.some((i) => (i as { assetId?: string }).assetId === 'as_missing')).toBe(false)
    expect(main.items.some((i) => i.name === 's03 · card')).toBe(true)
  })

  it('puts the still (with a slow pan) and the stock clip (filling the frame) on the main track', () => {
    const main = p.tracks.find((t) => t.main)!
    const img = main.items.find((i) => i.type === 'image')!
    expect(img).toMatchObject({ assetId: 'as_img', fit: 'cover' })
    expect((img as { effects: Array<{ type: string }> }).effects.map((e) => e.type)).toContain('kenBurns')
    const vid = main.items.filter((i) => i.type === 'video')
    expect(vid.length).toBeGreaterThan(0)
    expect(vid.every((v) => (v as { fit: string }).fit === 'cover' && (v as { assetId: string }).assetId === 'as_clip')).toBe(true)
    expect(p.assets.as_img).toBeDefined()
    expect(p.assets.as_clip).toBeDefined()
  })

  it('builds motion points and diagrams on graphics tracks, with no overlaps on any track', () => {
    const shapes = p.tracks.filter((t) => t.name.startsWith('Graphics '))
    const texts = p.tracks.filter((t) => t.name.startsWith('Graphic text '))
    expect(shapes.length).toBeGreaterThan(0)
    expect(texts.length).toBeGreaterThan(0)
    expect(shapes.every((t) => t.kind === 'overlay')).toBe(true)
    expect(texts.every((t) => t.kind === 'text')).toBe(true)
    const words = texts.flatMap((t) => t.items).map((i) => (i as { text?: string }).text)
    expect(words).toEqual(expect.arrayContaining(['Less waiting', 'Plan', 'Build', 'Ship', '3x']))
    for (const tr of p.tracks) {
      const items = [...tr.items].sort((a, b) => a.start - b.start)
      for (let i = 1; i < items.length; i++) expect(items[i].start, `${tr.name}: ${items[i].name}`).toBeGreaterThanOrEqual(itemEnd(items[i - 1]) - 1e-6)
    }
    // graphics sit between the main track and the headlines
    const names = p.tracks.map((t) => t.name)
    expect(names.indexOf('Main')).toBeLessThan(names.indexOf('Graphics 1'))
    expect(names.indexOf('Graphic text 1')).toBeLessThan(names.indexOf('Headlines'))
  })

  it('renders every scene (layers present mid-scene) and nothing runs past the end', () => {
    const end = projectDuration(p)
    for (const tr of p.tracks) for (const it of tr.items) expect(itemEnd(it)).toBeLessThanOrEqual(end + 1e-6)
    const mid = evaluate(p, 3 + 0.5 + 3)
    expect(mid.layers.length).toBeGreaterThan(2)
  })
})

describe('animation scenes and stock photos', () => {
  const voice = (id: string, text: string): { asset: Asset; duration: number } => ({ asset: { id, kind: 'audio', name: id, src: '', duration: 6, transcript: syntheticTranscript(text, 6) }, duration: 6 })
  const art = (id: string): Asset => ({ id, kind: 'image', name: `${id} (illustration)`, src: '', width: 1024, height: 1024 })

  it('the writer’s animations and photos become scene visuals; an animation with nothing to draw becomes animated text', () => {
    const out: IdeaScriptOutput = {
      message: 'm',
      scenes: [
        scene({ kind: 'animation', animStyle: 'journey', objects: ['delivery truck', ' house ', 'gift'], labels: ['Shipped', '', 'Delivered'] }, 'The truck leaves, passes the house, and delivers the gift.'),
        scene({ kind: 'animation', animStyle: 'none', objects: ['rocket'], labels: [] }),
        scene({ kind: 'animation', animStyle: 'orbit', objects: [], labels: [] }),
        scene({ kind: 'photo', query: ' farmer in wheat field ' }),
        scene({ kind: 'photo', query: '' }),
      ],
    }
    const scenes = normalizeIdeaScript(out, ['motion', 'animation', 'photo'])
    expect(scenes[0].visual).toEqual({ kind: 'animation', style: 'journey', objects: [{ name: 'delivery truck', label: 'Shipped' }, { name: 'house' }, { name: 'gift', label: 'Delivered' }] })
    // no style given: one by one
    expect(scenes[1].visual).toMatchObject({ kind: 'animation', style: 'row' })
    expect(scenes[2].visual?.kind).toBe('motion')
    expect(scenes[3].visual).toEqual({ kind: 'photo', query: 'farmer in wheat field' })
    expect(scenes[4].visual?.kind).toBe('motion')
    // not allowed here: animated text instead
    expect(normalizeIdeaScript(out, ['motion'])[0].visual?.kind).toBe('motion')
  })

  it('the API takes animations and photos as edited in the review step, and nothing that isn’t one', () => {
    expect(VisualSchema.safeParse({ kind: 'animation', style: 'orbit', objects: [{ name: 'sun' }, { name: 'earth', label: 'Home', assetId: 'as_1', icon: 'noto:globe-showing-americas' }] }).success).toBe(true)
    expect(VisualSchema.safeParse({ kind: 'animation', style: 'spiral', objects: [{ name: 'sun' }] }).success).toBe(false)
    expect(VisualSchema.safeParse({ kind: 'animation', style: 'row', objects: [] }).success).toBe(false)
    expect(VisualSchema.safeParse({ kind: 'animation', style: 'row', objects: [{ name: 'x', icon: '../../etc/passwd' }] }).success).toBe(false)
    expect(VisualSchema.safeParse({ kind: 'photo', query: 'desk', credit: { author: 'Kim', url: 'https://flickr.com/x', source: 'Openverse', licence: 'CC BY 2.0' } }).success).toBe(true)
    expect(VisualSchema.safeParse({ kind: 'photo', query: 'desk', credit: { author: 'Kim', url: 'javascript:alert(1)' } }).success).toBe(false)
  })

  it('the prompt offers the writer animations and photos only when allowed', () => {
    const brief = { title: 'T', audience: '', goal: '', tone: '', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const, idea: 'How a parcel gets to you' }
    const yes = buildIdeaPrompt({ brief, kinds: ['motion', 'animation', 'photo'], rules: '', example: '' })
    expect(yes).toMatch(/- animation: colourful illustrations/)
    expect(yes).toMatch(/- photo: a real stock photograph/)
    expect(buildIdeaPrompt({ brief, kinds: ['motion'], rules: '', example: '' })).not.toMatch(/- animation:/)
  })

  const build = (visual: ScriptScene['visual'], illustrations: Asset[] = [], generated?: Asset, aspect: '16:9' | '9:16' = '16:9') => {
    const sc: ScriptScene[] = [{ id: 's01', title: 'How', headline: 'How it gets to you', narration: 'The truck leaves the warehouse, passes the house, and delivers the gift.', footage: [], visual }]
    return buildProducerTimeline({
      project: createProject({ id: 'p_anim', name: 'Anim' }),
      brief: { title: 'Anim', audience: '', goal: '', tone: 'warm', template: 'studio-dark', voice: 'af_heart', aspect, source: 'idea' },
      scenes: sc,
      footage: new Map(),
      voices: new Map(sc.map((s) => [s.id, voice(`as_vo_${s.id}`, s.narration)])),
      generated: generated ? new Map([['s01', generated]]) : undefined,
      illustrations: new Map(illustrations.map((a) => [a.id, a])),
    })
  }
  const pictures = (q: Project) => q.tracks.filter((t) => !t.main).flatMap((t) => t.items).filter((i) => i.type === 'image')

  for (const style of ['row', 'journey', 'orbit', 'grow', 'burst', 'change'] as const) {
    it(`a “${style}” animation: its illustrations move inside the frame and arrive in order, as they are named`, () => {
      for (const aspect of ['16:9', '9:16'] as const) {
        const q = build(
          {
            kind: 'animation',
            style,
            objects: [
              { name: 'truck', label: 'Shipped', assetId: 'as_a' },
              { name: 'house', assetId: 'as_b' },
              { name: 'gift', label: 'Delivered', assetId: 'as_c' },
            ],
          },
          [art('as_a'), art('as_b'), art('as_c')],
          undefined,
          aspect,
        )
        const pics = pictures(q)
        expect(pics.length).toBeGreaterThanOrEqual(3)
        // every illustration is in the project, on a track above the main one
        for (const id of ['as_a', 'as_b', 'as_c']) expect(q.assets[id]).toBeDefined()
        const first = (id: string) => Math.min(...pics.filter((p) => p.assetId === id).map((p) => p.start))
        expect(first('as_a')).toBeLessThanOrEqual(first('as_b') + 0.5)
        expect(first('as_b')).toBeLessThan(first('as_c'))
        // nowhere outside the canvas (keyframed positions included), and every keyframe within the item's life
        const half = { x: q.width / 2, y: q.height / 2 }
        for (const it of pics) {
          if (it.type !== 'image') continue
          const xs = [it.transform.x, ...(it.keyframes.x ?? []).map((k) => k.value)]
          const ys = [it.transform.y, ...(it.keyframes.y ?? []).map((k) => k.value)]
          for (const x of xs) expect(Math.abs(x)).toBeLessThan(half.x)
          for (const y of ys) expect(Math.abs(y)).toBeLessThan(half.y)
          for (const k of Object.values(it.keyframes).flat()) expect(k!.t).toBeLessThanOrEqual(it.duration + 1e-6)
          expect(it.start + it.duration).toBeLessThanOrEqual(q.tracks.find((t) => t.main)!.items.at(-2)!.start + q.tracks.find((t) => t.main)!.items.at(-2)!.duration + 1e-6)
        }
        // the captions given are shown
        const texts = q.tracks.flatMap((t) => t.items).filter((i) => i.type === 'text').map((i) => (i as { text: string }).text)
        expect(texts).toEqual(expect.arrayContaining(['Shipped', 'Delivered']))
      }
    })
  }

  it('an object with no illustration found is a labelled disc, so the scene still says what it means', () => {
    const q = build({ kind: 'animation', style: 'row', objects: [{ name: 'quantum widget' }, { name: 'house', assetId: 'as_b' }] }, [art('as_b')])
    expect(pictures(q).map((p) => p.assetId)).toEqual(['as_b'])
    const all = q.tracks.flatMap((t) => t.items)
    expect(all.some((i) => i.type === 'shape' && i.name === 'quantum widget (no picture found)')).toBe(true)
    expect(all.some((i) => i.type === 'text' && (i as { text: string }).text === 'quantum widget')).toBe(true)
  })

  it('a stock photo fills the frame with a slow pan; a CC BY one gets a credit line, a Pexels one none', () => {
    const photo: Asset = { id: 'as_ph', kind: 'image', name: 'field', src: '', width: 1920, height: 1080 }
    const credited = build({ kind: 'photo', query: 'field', assetId: 'as_ph', credit: { author: 'Kim', url: 'https://flickr.com/k', source: 'Openverse', licence: 'CC BY 2.0' } }, [], photo)
    const img = credited.tracks.find((t) => t.main)!.items.find((i) => i.type === 'image')!
    expect(img).toMatchObject({ assetId: 'as_ph', fit: 'cover' })
    const credit = credited.tracks.flatMap((t) => t.items).find((i) => i.name === 's01 credit') as { text: string } | undefined
    expect(credit?.text).toBe('Photo: Kim · CC BY 2.0 · Openverse')
    const plain = build({ kind: 'photo', query: 'field', assetId: 'as_ph', credit: { author: 'Pat', url: 'https://www.pexels.com/photo/1/', source: 'Pexels' } }, [], photo)
    expect(plain.tracks.flatMap((t) => t.items).some((i) => i.name === 's01 credit')).toBe(false)
  })
})

describe('a script for a video nobody speaks in', () => {
  const brief = { title: 'T', audience: '', goal: '', tone: 'warm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const, source: 'idea' as const, idea: 'A rocket' }
  const prompt = (over: object, kinds: VisualKind[] = ['animation', 'drawn']) => buildIdeaPrompt({ brief: { ...brief, ...over }, kinds, rules: '', example: '' })

  it('says so, and says what the narration field is for instead', () => {
    expect(prompt({})).toMatch(/Narration 15-60 words/)
    expect(prompt({})).not.toMatch(/NOBODY SPEAKS/)
    const silent = prompt({ narration: false, music: 'auto' })
    expect(silent).toMatch(/NOBODY SPEAKS IN THIS VIDEO: it is pictures and music only/)
    expect(silent).not.toMatch(/Narration 15-60 words/)
    expect(silent).not.toMatch(/what the voice says/)
  })

  it('tells it the viewer reads nothing, and only offers text kinds when there can be text', () => {
    expect(prompt({})).not.toMatch(/NO WORDS ON SCREEN/)
    expect(prompt({ onScreenText: false })).toMatch(/NO WORDS ON SCREEN/)
    expect(prompt({})).not.toMatch(/keep text and diagrams/)
    expect(prompt({}, ['motion', 'animation', 'drawn'])).toMatch(/keep text and diagrams/)
  })
})
