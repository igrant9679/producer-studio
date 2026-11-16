// What the real script writer picks for an idea when every visual is on (the locally signed-in Claude Code CLI). Runs
// only with REAL_DRAW=1; prints each scene's visual for a person to read.
import { beforeAll, describe, expect, it } from 'vitest'
import { ClaudeCliProvider } from '../ai/cli'
import { castIn, normalizeCast, withCast } from '../ai/cast'
import { IDEA_SYSTEM, IdeaScriptSchema, buildIdeaPrompt, normalizeIdeaScript, VISUAL_KINDS } from '../ai/scenes'
import { setup } from './helpers'

const REAL = process.env.REAL_DRAW === '1'
beforeAll(async () => {
  if (REAL) await setup()
}, 120_000)

describe.skipIf(!REAL)('the real writer, from an idea', () => {
  it('uses animations, drawings and stock where they fit', async () => {
    const brief = { title: 'How compost works', audience: 'home gardeners', goal: 'start a compost bin this weekend', tone: 'warm, plain', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const, source: 'idea' as const, idea: 'A 45 second explainer: what compost is, the green + brown recipe, how microbes turn scraps into soil in about 3 months, and why your garden loves it.', lengthSec: 45 }
    const kinds = VISUAL_KINDS.filter((k) => k !== 'aiVideo' && k !== 'image')
    const raw = await new ClaudeCliProvider().structured({ system: IDEA_SYSTEM, prompt: buildIdeaPrompt({ brief, kinds, rules: '- Plain words.', example: 'Hook: Your scraps are worth more than you think.' }), images: [], schema: IdeaScriptSchema })
    const scenes = normalizeIdeaScript(IdeaScriptSchema.parse(raw), kinds)
    for (const s of scenes) console.log(`${s.id} [${s.visual?.kind}] ${s.headline} :: ${JSON.stringify(s.visual).slice(0, 260)}`)
    expect(scenes.length).toBeGreaterThan(2)
  }, 600_000)

  // A full-motion story (every scene an AI clip): the writer names the characters that return and says how each looks,
  // once, and calls them by those names in the scenes. Prints the cast and what each clip would be asked for.
  it('names the cast of a film, and calls the characters by those names in every scene', async () => {
    const idea =
      'A heartwarming 30-second animated short, "A Friend in Every Season": a small, curious orange fox meets a tiny blue bird sitting sadly beneath a tree in a magical forest; the bird hops onto the fox’s head and they chase butterflies; dark clouds and heavy rain, the fox shelters the bird beneath a large tree; the rain stops, sunlight returns and the bird nuzzles the fox; they sit together on a hill watching a golden sunset. Consistent character designs throughout.'
    const brief = { title: 'A Friend in Every Season', audience: '', goal: '', tone: 'Calm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const, source: 'idea' as const, idea, lengthSec: 30, motion: 'full' as const, aiLook: 'animated3d', narration: false, captions: false, onScreenText: false, cards: false }
    const kinds = ['aiVideo' as const]
    const raw = await new ClaudeCliProvider().structured({ system: IDEA_SYSTEM, prompt: buildIdeaPrompt({ brief, kinds, rules: '- Plain words.', example: 'Hook: Your scraps are worth more than you think.' }), images: [], schema: IdeaScriptSchema })
    const out = IdeaScriptSchema.parse(raw)
    const cast = normalizeCast(out.cast)
    const scenes = normalizeIdeaScript(out, kinds)
    console.log(`CAST ${JSON.stringify(cast, null, 1)}`)
    for (const s of scenes) {
      const prompt = (s.visual as { prompt?: string }).prompt ?? ''
      console.log(`${s.id} [${s.visual?.kind}] shows ${castIn(prompt, cast).map((c) => c.name).join(' + ') || 'nobody'} :: ${prompt}`)
    }
    console.log(`A CLIP IS ASKED FOR
${withCast((scenes[0].visual as { prompt: string }).prompt, castIn((scenes[0].visual as { prompt: string }).prompt, cast), 2)}`)
    expect(cast.length).toBeGreaterThanOrEqual(2)
    // every character returns: each is found in at least two scenes by the name the cast gives it
    for (const c of cast) expect(scenes.filter((s) => castIn((s.visual as { prompt?: string }).prompt ?? '', [c]).length).length).toBeGreaterThan(1)
  }, 600_000)
})
