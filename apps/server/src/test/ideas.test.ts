// Videos made from an idea: the writer's scene format, reveal timing, diagram/motion layouts and the timeline.
import { beforeAll, describe, expect, it } from 'vitest'
import { createProject, evaluate, itemEnd, projectDuration, type Asset, type Project, type ScriptScene } from '@producer/core'
import { buildProducerTimeline, syntheticTranscript } from '../ai/produce'
import { type IdeaScriptOutput, VisualSchema, normalizeIdeaScript } from '../ai/scenes'
import { diagramItems, revealTimes, type SceneFrame } from '../ai/scene-layout'
import { type Palette, getLook, lookPalette } from '../services/looks'
import { setup } from './helpers'

let pal: Palette
beforeAll(async () => {
  await setup()
  pal = lookPalette(getLook('studio-dark'))
})

type FlatVisual = IdeaScriptOutput['scenes'][number]['visual']
const blank: FlatVisual = { kind: 'motion', points: [], diagramType: 'none', items: [], details: [], values: [], unit: '', center: '', leftTitle: '', leftPoints: [], rightTitle: '', rightPoints: [], prompt: '', query: '' }
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

  it('refuses visuals the API must not store', () => {
    expect(VisualSchema.safeParse({ kind: 'diagram', diagram: { type: 'steps', items: Array(9).fill('x') } }).success).toBe(false)
    expect(VisualSchema.safeParse({ kind: 'stock', query: 'city', credit: { author: 'A', url: 'javascript:alert(1)' } }).success).toBe(false)
    expect(VisualSchema.safeParse({ kind: 'teleport' }).success).toBe(false)
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
