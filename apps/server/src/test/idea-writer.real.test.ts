// What the real script writer picks for an idea when every visual is on (the locally signed-in Claude Code CLI). Runs
// only with REAL_DRAW=1; prints each scene's visual for a person to read.
import { beforeAll, describe, expect, it } from 'vitest'
import { ClaudeCliProvider } from '../ai/cli'
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
})
