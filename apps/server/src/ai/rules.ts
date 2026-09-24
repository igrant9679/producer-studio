// House production rules for the script writer, read at runtime from the producer-pipeline skill
// (PRODUCER_SKILL_DIR) with a compact built-in fallback.
import fs from 'node:fs'
import path from 'node:path'
import { ctx } from '../context'

const FALLBACK_RULES = `Narration vs on-screen text: narration is what the voice SAYS; headlines are what the viewer READS.
Spell product numerals as spoken in narration ("Data 360" -> "Data three sixty") but keep official spelling on screen.
Avoid homographs the voice misreads (live/lives, read, lead) by rephrasing.
Timing: scene duration = voice length + 0.5 s lead-in + 1.4 s tail (1.8 s for the close); narration is paced at ~2.8 words/second.
Headlines are 3-6 words (2-4 for vertical video). One idea per scene.`

const FALLBACK_EXAMPLE = `## s01 — Hook
Every opportunity, lead, and campaign is already in one place. So that's where we keep our analytics too. This is how the team runs pipeline analytics without ever leaving the platform.

## s02 — Where it lives
Open it from the App Launcher. Either way you land on Home, where every asset the team has built is listed in one place.`

function section(md: string, startRe: RegExp, endRe: RegExp): string {
  const s = md.search(startRe)
  if (s < 0) return ''
  const rest = md.slice(s)
  const e = rest.slice(3).search(endRe)
  return (e < 0 ? rest : rest.slice(0, e + 3)).trim()
}

export function houseRules(): { rules: string; example: string } {
  const dir = ctx().config.producerSkillDir
  let rules = ''
  let example = ''
  try {
    const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
    const timing = section(skill, /^## 2\. Timing/m, /^## /m)
    const s2b = section(skill, /^## 2b\./m, /^## /m)
    const s3 = section(skill, /^## 3\./m, /^## /m)
    rules = [timing, s2b, s3].filter(Boolean).join('\n\n')
  } catch {
    /* fallback */
  }
  try {
    example = fs.readFileSync(path.join(dir, 'examples', 'SCRIPT.approved.md'), 'utf8').trim()
  } catch {
    /* fallback */
  }
  return { rules: (rules || FALLBACK_RULES).slice(0, 12000), example: (example || FALLBACK_EXAMPLE).slice(0, 8000) }
}
