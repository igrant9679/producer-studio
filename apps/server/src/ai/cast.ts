// The cast of a video made from an idea: the characters seen in more than one generated picture or clip.
//
// Every AI picture and clip is made on its own, from its own words, so the same "small orange fox" came back with
// other eyes, another build and a bird twice the size in each clip of a real five-clip film. So the script writer says
// once how each returning character looks (ScriptCharacter, kept on the script as `cast`), and:
//   - every picture and clip that shows a character is given that description word for word (withCast);
//   - where the clip model takes reference pictures (Gemini Omni: up to 3 per character, for up to 2 characters), one
//     picture of each character is painted first (characterPicturePrompt) and sent with every clip it is in.
// Their sizes drifted next (the bird as big as the fox's head in a two-shot, small again on the fox's back): each
// picture shows its character filling the frame, so nothing says how big one is beside the other. The cast therefore
// also says how tall each character stands (heightCm), every prompt that shows two of them says how their heights
// compare (sizesLine), and a clip that shows them is sent one more picture, the characters side by side at those
// sizes (media/size-chart.ts).
import type { ScriptCharacter } from '@producer/core'

/** Characters a script may name (the writer is asked for the ones that return, most important first). */
export const MAX_CAST = 4
/** Characters whose reference picture a clip is given at most (the clip model's own limit). */
export const MAX_REFERENCED = 2

const clean = (s: unknown, max: number) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

/** The writer's cast, tidied: characters with a name and a look, none twice. */
export function normalizeCast(cast: unknown): ScriptCharacter[] {
  if (!Array.isArray(cast)) return []
  const out: ScriptCharacter[] = []
  for (const c of cast) {
    const name = clean((c as { name?: unknown } | null)?.name, 80)
    const look = clean((c as { look?: unknown } | null)?.look, 500)
    if (!name || !look || out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue
    // a height that can be one: from an insect to a giant (anything else is left out, and sizes go unsaid)
    const h = Number((c as { heightCm?: unknown } | null)?.heightCm)
    const heightCm = Number.isFinite(h) && h >= 0.5 && h <= 5000 ? (h < 10 ? Math.round(h * 10) / 10 : Math.round(h)) : undefined
    out.push({ name, look, ...(heightCm ? { heightCm } : {}) })
    if (out.length >= MAX_CAST) break
  }
  return out
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** The characters a scene's description shows: named in it in full, or by the last word of their name ("the fox"). */
export function castIn(prompt: string, cast: ScriptCharacter[]): ScriptCharacter[] {
  const text = ` ${words(prompt).join(' ')} `
  return cast.filter((c) => {
    const n = words(c.name.replace(/^(the|a|an)\s+/i, ''))
    return n.length > 0 && (text.includes(` ${n.join(' ')} `) || text.includes(` ${n[n.length - 1]} `))
  })
}

const FRACTIONS: Array<[number, string]> = [
  [0.9, 'about as tall as'],
  [0.7, 'about three quarters as tall as'],
  [0.58, 'about two thirds as tall as'],
  [0.42, 'about half as tall as'],
  [0.29, 'about a third as tall as'],
  [0.225, 'about a quarter as tall as'],
  [0.18, 'about a fifth as tall as'],
  [0.155, 'about a sixth as tall as'],
  [0.133, 'about a seventh as tall as'],
  [0.118, 'about an eighth as tall as'],
  [0.095, 'about a tenth as tall as'],
]

/** A height against a taller one, in plain words: 8 against 30 is "about a quarter as tall as". */
export function tallAs(ratio: number): string {
  return FRACTIONS.find(([least]) => ratio >= least)?.[1] ?? 'less than a tenth as tall as'
}

const cm = (h: number) => (h >= 100 ? `${(h / 100).toFixed(h % 10 ? 2 : 1).replace(/\.?0+$/, '')} m` : `${h} cm`)

/**
 * How the characters of one shot compare in size, when at least two of them have a height: said the same way in
 * every prompt, so the smaller one is not enlarged to read better in a close shot. `chartAt`: the reference picture
 * that shows them side by side at these sizes.
 */
export function sizesLine(shown: ScriptCharacter[], chartAt?: number): string {
  const sized = shown.filter((c) => c.heightCm).sort((a, b) => b.heightCm! - a.heightCm!)
  if (sized.length < 2) return ''
  const tallest = sized[0]
  const compared = sized.slice(1).map((c) => `${c.name} is ${tallAs(c.heightCm! / tallest.heightCm!)} ${tallest.name}`)
  return `Their sizes, the same in every shot (${sized.map((c) => `${c.name} stands about ${cm(c.heightCm!)} tall`).join(', ')}): ${compared.join('; ')}. Keep that difference in size in every shot, close-ups included: never enlarge a smaller character so that it reads better.${chartAt ? ` Reference picture ${chartAt} shows them side by side at these sizes.` : ''}`
}

/**
 * A scene's picture or clip description with its characters' looks said the same way every time. The first
 * `pictured` of them come with a reference picture, sent in that order; `chartAt` is the reference picture (sent
 * after those) that shows them side by side at their true sizes.
 */
export function withCast(prompt: string, cast: ScriptCharacter[], pictured = 0, chartAt?: number): string {
  if (!cast.length) return prompt
  const lines = cast.map((c, i) => `- ${c.name}: ${c.look}${i < pictured ? ` (shown in reference picture ${i + 1})` : ''}`)
  const sizes = sizesLine(cast, chartAt)
  return `${prompt.trim()}

The characters, the same in every shot of this film (keep each one's design exactly as described${pictured ? ' and as its reference picture shows' : ''}; never redesign them):
${lines.join('\n')}${sizes ? `\n${sizes}` : ''}${pictured ? '\nThe reference pictures only show what the characters look like: do not copy their plain background, their pose or their framing.' : ''}`
}

/** What the image AI is asked for when it paints a character's reference picture. */
export const characterPicturePrompt = (c: ScriptCharacter) =>
  `A reference picture of one character of a film: ${c.name}. ${c.look}

Show the whole character from head to foot, alone, standing in a relaxed neutral pose, seen from the front at a slight angle, on a plain light grey background in soft even light. Nothing else in the picture: no scenery, no other characters, no words, letters or logos.`
