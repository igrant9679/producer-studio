// The cast of a video made from an idea: the characters seen in more than one generated picture or clip.
//
// Every AI picture and clip is made on its own, from its own words, so the same "small orange fox" came back with
// other eyes, another build and a bird twice the size in each clip of a real five-clip film. So the script writer says
// once how each returning character looks (ScriptCharacter, kept on the script as `cast`), and:
//   - every picture and clip that shows a character is given that description word for word (withCast);
//   - where the clip model takes reference pictures (Gemini Omni: up to 3 per character, for up to 2 characters), one
//     picture of each character is painted first (characterPicturePrompt) and sent with every clip it is in.
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
    out.push({ name, look })
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

/**
 * A scene's picture or clip description with its characters' looks said the same way every time. The first
 * `pictured` of them come with a reference picture, sent in that order.
 */
export function withCast(prompt: string, cast: ScriptCharacter[], pictured = 0): string {
  if (!cast.length) return prompt
  const lines = cast.map((c, i) => `- ${c.name}: ${c.look}${i < pictured ? ` (shown in reference picture ${i + 1})` : ''}`)
  return `${prompt.trim()}

The characters, the same in every shot of this film (keep each one's design exactly as described${pictured ? ' and as its reference picture shows' : ''}; never redesign them):
${lines.join('\n')}${pictured ? '\nThe reference pictures only show what the characters look like: do not copy their plain background, their pose or their framing.' : ''}`
}

/** What the image AI is asked for when it paints a character's reference picture. */
export const characterPicturePrompt = (c: ScriptCharacter) =>
  `A reference picture of one character of a film: ${c.name}. ${c.look}

Show the whole character from head to foot, alone, standing in a relaxed neutral pose, seen from the front at a slight angle, on a plain light grey background in soft even light. Nothing else in the picture: no scenery, no other characters, no words, letters or logos.`
