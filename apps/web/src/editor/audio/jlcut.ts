// J and L cuts from the timeline (E-13): Shift on an audio clip's trim handle (or Shift+[ / Shift+] with the clip
// focused) moves only that sound's edge, so it leads or trails its linked picture; a touching sound rolls with it.
import { rollAudioEdge, type Item, type Project } from '@producer/core'

/** The J/L trim the modifier asks for, or null for an ordinary trim. */
export function jlTrim(mod: { shiftKey: boolean }, p: Project, item: Item, edge: 'start' | 'end', t: number): Project | null {
  if (!mod.shiftKey || item.type !== 'audio') return null
  return rollAudioEdge(p, item.id, edge, t)
}
