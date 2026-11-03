// Videos made from an idea (no recordings): the script writer's scene format, and how each scene's visual becomes
// timeline items. Motion text, diagrams and animations are built from the editor's own text, shape and image items
// (editable, on brand, identical in preview and export); AI stills, stock clips and photos, AI clips and the animations'
// illustrations arrive as assets (ai/generate); the person's own clips and images (`media`) are library assets already.
import * as z from 'zod/v4'
import type { AnimationStyle, DiagramType, SceneDiagram, SceneVisual, ScriptScene, VisualKind } from '@producer/core'
import { HttpError } from '../http'

export const VISUAL_KINDS: VisualKind[] = ['motion', 'diagram', 'animation', 'drawn', 'image', 'photo', 'stock', 'aiVideo']
export const ANIMATION_STYLES: AnimationStyle[] = ['row', 'journey', 'orbit', 'grow', 'burst', 'change']
export const DIAGRAM_TYPES: DiagramType[] = ['steps', 'cycle', 'hub', 'bars', 'compare', 'timeline', 'stat']

const short = (max: number) => z.string().trim().max(max)

// shown as a link in the app: https only (a javascript: URL is a "valid URL" too)
const CreditSchema = z.object({
  author: short(120),
  url: z.string().max(400).regex(/^https:\/\/[^\s"'<>]+$/, 'must be an https link'),
  source: short(40).optional(),
  licence: short(40).optional(),
})

/** A scene visual as the API accepts it (assemble requests, edits in the review step). */
export const VisualSchema: z.ZodType<SceneVisual> = z.union([
  z.object({ kind: z.literal('footage') }),
  z.object({ kind: z.literal('motion'), points: z.array(short(120)).max(5).optional() }),
  z.object({
    kind: z.literal('diagram'),
    diagram: z.union([
      z.object({ type: z.literal('steps'), items: z.array(short(60)).min(2).max(6) }),
      z.object({ type: z.literal('cycle'), items: z.array(short(40)).min(3).max(6) }),
      z.object({ type: z.literal('hub'), center: short(40), items: z.array(short(40)).min(2).max(6) }),
      z.object({ type: z.literal('bars'), items: z.array(z.object({ label: short(40), value: z.number().finite() })).min(2).max(6), unit: short(12).optional() }),
      z.object({
        type: z.literal('compare'),
        left: z.object({ title: short(40), points: z.array(short(80)).max(4) }),
        right: z.object({ title: short(40), points: z.array(short(80)).max(4) }),
      }),
      z.object({ type: z.literal('timeline'), items: z.array(z.object({ label: short(30), detail: short(60).optional() })).min(2).max(6) }),
      z.object({ type: z.literal('stat'), value: short(16), label: short(80) }),
    ]),
  }),
  z.object({ kind: z.literal('image'), prompt: short(1000), assetId: z.string().max(80).optional() }),
  z.object({ kind: z.literal('stock'), query: short(120), assetId: z.string().max(80).optional(), credit: CreditSchema.optional() }),
  z.object({ kind: z.literal('photo'), query: short(120), assetId: z.string().max(80).optional(), credit: CreditSchema.optional() }),
  z.object({
    kind: z.literal('animation'),
    style: z.enum(ANIMATION_STYLES as [AnimationStyle, ...AnimationStyle[]]),
    objects: z
      .array(z.object({ name: short(40).min(1), label: short(60).optional(), assetId: z.string().max(80).optional(), icon: z.string().max(80).regex(/^[a-z0-9-]+:[a-z0-9-]+$/).optional() }))
      .min(1)
      .max(5),
  }),
  z.object({ kind: z.literal('aiVideo'), prompt: short(1000), assetId: z.string().max(80).optional() }),
  z.object({ kind: z.literal('drawn'), prompt: short(1500), code: z.string().max(60_000).optional(), assetId: z.string().max(80).optional() }),
  z.object({ kind: z.literal('media'), assetId: z.string().min(1).max(80), start: z.number().finite().min(0).optional(), end: z.number().finite().min(0).optional() }),
]) as z.ZodType<SceneVisual>

// ---------------- the writer's output (idea mode) ----------------
// Flat, every field present: structured output is strictest about unions and optional fields, so the model fills
// unused fields with empty values and normalizeIdeaScript() turns each scene into a SceneVisual.

export const IdeaScriptSchema = z.object({
  message: z.string().describe('The one-sentence message of the video'),
  scenes: z.array(
    z.object({
      id: z.string().describe('s01, s02, ... in order'),
      title: z.string().describe('Short scene label, e.g. Hook, How it works, Close'),
      headline: z.string().describe('3-6 word on-screen headline (2-4 for vertical)'),
      narration: z.string().describe('Exactly what the narrator says, written as spoken'),
      visual: z.object({
        kind: z.enum(['motion', 'diagram', 'animation', 'drawn', 'image', 'photo', 'stock', 'aiVideo', 'media']).describe('What fills the screen for this scene'),
        points: z.array(z.string()).describe('motion: 2-4 short on-screen points revealed in order (else empty)'),
        diagramType: z.enum(['none', 'steps', 'cycle', 'hub', 'bars', 'compare', 'timeline', 'stat']).describe('diagram: which diagram (else none)'),
        items: z.array(z.string()).describe('diagram steps/cycle/hub/timeline/bars: the labels in order, 2-6, each 1-4 words (else empty)'),
        details: z.array(z.string()).describe('diagram timeline: a short detail per item, same order (else empty)'),
        values: z.array(z.number()).describe('diagram bars: one number per item (else empty)'),
        unit: z.string().describe('diagram bars: unit such as %, $, hrs (else empty)'),
        center: z.string().describe('diagram hub: the centre label; stat: the big number or figure, e.g. 3x or 42% (else empty)'),
        leftTitle: z.string().describe('diagram compare: left column title; stat: the label under the figure (else empty)'),
        leftPoints: z.array(z.string()).describe('diagram compare: left column points, 1-4 (else empty)'),
        rightTitle: z.string().describe('diagram compare: right column title (else empty)'),
        rightPoints: z.array(z.string()).describe('diagram compare: right column points, 1-4 (else empty)'),
        prompt: z.string().describe('image / aiVideo: a vivid visual description of the shot, no text or logos in it; drawn: the animation beat by beat, what is drawn and how it moves on which words (else empty)'),
        query: z.string().describe('stock / photo: 2-5 word search, concrete and visual (else empty)'),
        animStyle: z.enum(['none', 'row', 'journey', 'orbit', 'grow', 'burst', 'change']).describe('animation: how the illustrations move (else none)'),
        objects: z.array(z.string()).describe('animation: 1-5 things to illustrate, each 1-2 plain words naming an everyday object, animal, person or symbol, e.g. rocket, money bag, laptop, globe (else empty)'),
        labels: z.array(z.string()).describe('animation: a 1-3 word caption per object, same order, or empty strings (else empty)'),
        mediaId: z.string().describe('media: which of YOUR MEDIA to show, e.g. m2 (else empty)'),
      }),
    }),
  ),
})
export type IdeaScriptOutput = z.infer<typeof IdeaScriptSchema>

export const IDEA_SYSTEM =
  'You are the script writer and director for Producer, which turns an idea into a short narrated, branded video. You write warm, plain, spoken narration with one idea per scene, and for each scene you choose the visual that explains it best: the person’s own clips and images when they added some, animated text, a clear diagram, an animation of illustrations, a stock photo or clip, a generated image or a generated video clip.'

const KIND_GUIDE: Record<VisualKind, string> = {
  footage: '',
  motion: '- motion: the headline animates in and 2-4 short points appear one by one as they are said. Good for lists, takeaways, the hook and the close.',
  diagram:
    '- diagram: an animated diagram whose parts appear as the narration names them. Types: steps (a process, 2-6 steps), cycle (a repeating loop, 3-6), hub (one idea and its 2-6 parts), bars (2-6 values to compare, real numbers only), compare (two columns: before/after, us/them), timeline (2-6 dated or ordered events), stat (one big number and what it means). Use the exact labels the narration says.',
  image: '- image: a generated still image with a slow pan and zoom. Write a vivid, specific shot description (subject, setting, light, style). No words, logos or UI in the image.',
  animation:
    '- animation: colourful illustrations (emoji-style art of everyday things) that move as the narration names them. Name 1-5 objects in plain words (rocket, money bag, laptop, house, globe, clock, person, light bulb) and pick a style: row (they pop in one by one: a list of things), journey (the first travels past the others: a process, a delivery, a customer journey), orbit (the rest circle the first: one thing and what surrounds it), grow (each bigger than the last: growth, scale), burst (copies of the rest fly out of the first: one cause, many results), change (the first turns into the second: before and after). Great for explaining ideas with no footage; use it often.',
  drawn:
    '- drawn: a custom animated illustration drawn in code for this scene (hand-drawn or flat style: simple characters acting, objects that move, a process unfolding, a map, a chart that builds, a metaphor in motion). Write the director’s note in prompt: what is drawn, what moves, and on which words of the narration. Best for the scenes that most need showing rather than telling; use it for up to 6 scenes.',
  photo: '- photo: a real stock photograph with a slow pan and zoom. Give a short, concrete search such as "farmer in wheat field" or "doctor with patient".',
  stock: '- stock: real stock video footage. Give a short, concrete search such as "team meeting whiteboard" or "city traffic night"; keep it to common, filmable subjects.',
  aiVideo: '- aiVideo: a generated video clip (expensive, use for at most 2 scenes where real motion matters). Describe one continuous shot: subject, action, camera move, setting, light. No words or logos.',
  media: '- media: one of the clips or images under YOUR MEDIA, filling the screen (images get a slow pan and zoom). Set mediaId to its m-number.',
}

/** One of the person's own clips or images, as the writer sees it (m1, m2, … in the order they were added). */
export interface IdeaMedia {
  ref: string
  assetId: string
  kind: 'video' | 'image'
  name: string
  duration?: number
  /** What a clip says, when it has been transcribed. */
  speech?: string
}

function mediaLine(m: IdeaMedia): string {
  const what = m.kind === 'image' ? 'image' : `video clip, ${Math.max(1, Math.round(m.duration ?? 0))} s`
  return `- ${m.ref} · ${what} · "${m.name.replace(/"/g, "'").slice(0, 80)}"${m.speech ? ` · says: "${m.speech.replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, 240)}"` : ''}`
}

/** What a good mix looks like with the kinds on offer (a writer left alone leans on text and diagrams). */
function mix(kinds: VisualKind[]): string {
  const want: string[] = []
  if (kinds.includes('drawn')) want.push('draw (drawn) the one or two scenes that most need showing: a process, a change, a cause and effect, a character doing something')
  if (kinds.includes('photo') || kinds.includes('stock')) want.push(`show real people, places and things with ${kinds.includes('photo') && kinds.includes('stock') ? 'a stock photo or clip' : kinds.includes('photo') ? 'a stock photo' : 'a stock clip'} at least once`)
  if (kinds.includes('animation')) want.push('use animation for lists of things and simple journeys')
  return want.length ? ` In a video of four or more scenes: ${want.join('; ')}; keep text and diagrams for the points that are words or numbers.` : ''
}

export function buildIdeaPrompt(opts: { brief: NonNullable<import('@producer/core').ProducerMeta['brief']>; kinds: VisualKind[]; rules: string; example: string; media?: IdeaMedia[] }): string {
  const b = opts.brief
  const vertical = b.aspect === '9:16'
  const seconds = Math.max(15, Math.min(600, b.lengthSec ?? 60))
  const words = Math.round(seconds * 2.6)
  const scenes = Math.max(3, Math.min(14, Math.round(seconds / 9)))
  const media = opts.media ?? []
  const kinds = opts.kinds.filter((k) => k !== 'footage' && (k !== 'media' || media.length > 0))
  const yours = media.length
    ? `
YOUR MEDIA (the person's own clips and images, added for this video; their pictures follow the prompt, labelled with these m-numbers)
${media.map(mediaLine).join('\n')}
Build the video around these: show each where it fits what the narration says (kind "media"), use most of them, and the same one at most twice. Describe only what you can see in them. Fill the other scenes with the other kinds.
`
    : ''
  return `Write the production script for a narrated video made from the idea below. ${media.length ? 'The person added their own clips and images (YOUR MEDIA); the other' : 'There are no recordings: every'} scene's visual is one of the kinds listed.

BRIEF
- Title: ${b.title}
- Audience: ${b.audience || 'a general business audience'}
- Goal / message: ${b.goal || 'infer from the idea'}
- Tone: ${b.tone || 'warm, plain, confident'}
- Length: about ${seconds} seconds
- Aspect: ${b.aspect}${vertical ? ' (vertical: headlines 2-4 words, diagram labels 1-3 words)' : ''}
- Visual template: ${b.template}${b.notes ? `\n- Producer notes: ${b.notes}` : ''}

THE IDEA (a topic, an outline, or a full script — if it's a script, keep its words and split it into scenes)
${(b.idea ?? '').trim() || b.title}
${yours}
VISUALS YOU MAY USE (only these kinds)
${kinds.map((k) => KIND_GUIDE[k]).join('\n')}

HOUSE RULES
${opts.rules}

APPROVED EXAMPLE SCRIPT (match its register, rhythm and density; not its content)
${opts.example}

REQUIREMENTS
- Value-first story: the hook speaks the viewer's language, the message lands by scene 2, every later scene earns its place. Do not open with a rhetorical question.
- About ${scenes} scenes, ids s01..sNN in order; the last scene is the close. Narration 15-60 words per scene at ~2.6 words/second (about ${words} words in total).
- Vary the visuals; pick the one that makes each line easiest to understand.${mix(kinds)} Never put a number on screen that the narration doesn't say, and don't invent statistics: use bars or stat only with figures from the idea, otherwise use another visual.
- Headlines are what the viewer reads (official spelling); narration is what the voice says (spoken spelling).
- Fill every visual field; use empty strings, empty lists and diagramType "none" for fields that don't apply to the chosen kind.`
}

const clean = (s: string | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const list = (a: string[] | undefined, max: number, len: number) => (a ?? []).map((s) => clean(s, len)).filter(Boolean).slice(0, max)

/** The model's flat visual → a SceneVisual, or a motion scene when what it gave can't be drawn. */
export function toSceneVisual(v: IdeaScriptOutput['scenes'][number]['visual'], allowed: VisualKind[], fallbackPoints: string[] = [], media: IdeaMedia[] = []): SceneVisual {
  const motion = (): SceneVisual => ({ kind: 'motion', points: list(v.points?.length ? v.points : fallbackPoints, 4, 120) })
  if (!allowed.includes(v.kind)) return motion()
  switch (v.kind) {
    case 'motion':
      return motion()
    case 'image':
      return clean(v.prompt, 1000) ? { kind: 'image', prompt: clean(v.prompt, 1000) } : motion()
    case 'drawn':
      return clean(v.prompt, 1500) ? { kind: 'drawn', prompt: clean(v.prompt, 1500) } : motion()
    case 'aiVideo':
      return clean(v.prompt, 1000) ? { kind: 'aiVideo', prompt: clean(v.prompt, 1000) } : motion()
    case 'stock':
    case 'photo':
      return clean(v.query, 120) ? { kind: v.kind, query: clean(v.query, 120) } : motion()
    case 'animation': {
      const names = list(v.objects, 5, 40)
      if (!names.length) return motion()
      const labels = v.labels ?? []
      const style = v.animStyle && v.animStyle !== 'none' ? v.animStyle : 'row'
      return { kind: 'animation', style, objects: names.map((name, i) => ({ name, ...(clean(labels[i], 60) ? { label: clean(labels[i], 60) } : {}) })) }
    }
    case 'media': {
      const ref = clean(v.mediaId, 12).toLowerCase()
      const m = media.find((x) => x.ref === ref || x.assetId === clean(v.mediaId, 80))
      return m ? { kind: 'media', assetId: m.assetId } : motion()
    }
    case 'diagram': {
      const d = toDiagram(v)
      return d ? { kind: 'diagram', diagram: d } : motion()
    }
  }
  return motion()
}

function toDiagram(v: IdeaScriptOutput['scenes'][number]['visual']): SceneDiagram | null {
  const items = list(v.items, 6, 60)
  switch (v.diagramType) {
    case 'steps':
      return items.length >= 2 ? { type: 'steps', items } : null
    case 'cycle':
      return items.length >= 3 ? { type: 'cycle', items: items.map((s) => s.slice(0, 40)) } : null
    case 'hub':
      return items.length >= 2 && clean(v.center, 40) ? { type: 'hub', center: clean(v.center, 40), items: items.map((s) => s.slice(0, 40)) } : null
    case 'bars': {
      const vals = (v.values ?? []).filter((n) => Number.isFinite(n))
      const n = Math.min(items.length, vals.length)
      return n >= 2 ? { type: 'bars', items: items.slice(0, n).map((label, i) => ({ label: label.slice(0, 40), value: vals[i] })), ...(clean(v.unit, 12) ? { unit: clean(v.unit, 12) } : {}) } : null
    }
    case 'compare': {
      const left = { title: clean(v.leftTitle, 40), points: list(v.leftPoints, 4, 80) }
      const right = { title: clean(v.rightTitle, 40), points: list(v.rightPoints, 4, 80) }
      return left.title && right.title ? { type: 'compare', left, right } : null
    }
    case 'timeline': {
      if (items.length < 2) return null
      const details = v.details ?? []
      return { type: 'timeline', items: items.map((label, i) => ({ label: label.slice(0, 30), ...(clean(details[i], 60) ? { detail: clean(details[i], 60) } : {}) })) }
    }
    case 'stat':
      return clean(v.center, 16) ? { type: 'stat', value: clean(v.center, 16), label: clean(v.leftTitle, 80) } : null
  }
  return null
}

/** Idea-mode output → scenes (no footage windows). */
export function normalizeIdeaScript(out: IdeaScriptOutput, allowed: VisualKind[], media: IdeaMedia[] = []): ScriptScene[] {
  const scenes: ScriptScene[] = []
  out.scenes.forEach((s, i) => {
    const narration = s.narration.trim()
    if (!narration) return
    scenes.push({
      id: `s${String(i + 1).padStart(2, '0')}`,
      title: s.title.trim() || `Scene ${i + 1}`,
      headline: s.headline.trim(),
      narration,
      footage: [],
      visual: toSceneVisual(s.visual, allowed, [s.headline], media),
    })
  })
  if (!scenes.length) throw new HttpError(502, 'server', 'The AI returned an empty script')
  return scenes
}
