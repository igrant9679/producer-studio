// The command palette's pure parts (A-10, A-11): which commands match what was typed, in what order, and where a
// search hit opens.
import type { SearchHit } from '@producer/core'
import { projectPath } from '../actions'

export interface Command {
  id: string
  group: string
  title: string
  /** A second line ("Ctrl+N", "Switch to this space"). */
  detail?: string
  /** More words it is found by. */
  keywords?: string
  /** Changes something in the space (hidden from viewers). */
  write?: boolean
  run: () => void
}

/** How well `c` matches the words typed: 0 = not at all; more for a match at the start of the title or of a word. */
export function commandScore(c: Pick<Command, 'title' | 'keywords' | 'group'>, q: string): number {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return 1
  const title = c.title.toLowerCase()
  const hay = `${title} ${(c.keywords ?? '').toLowerCase()} ${c.group.toLowerCase()}`
  let score = 0
  for (const w of words) {
    if (!hay.includes(w)) return 0
    if (title.startsWith(w)) score += 4
    else if (new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title)) score += 3
    else if (title.includes(w)) score += 2
    else score += 1
  }
  return score
}

/** The commands that match, best first (ties keep their order). */
export function rankCommands<T extends Pick<Command, 'title' | 'keywords' | 'group'>>(list: T[], q: string, limit = 50): T[] {
  return list
    .map((c, i) => ({ c, i, s: commandScore(c, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c)
}

/** The group a search hit is listed under. */
export const HIT_GROUP: Record<SearchHit['kind'], string> = {
  project: 'Projects',
  template: 'Templates',
  media: 'Media',
  voice: 'Voices',
  export: 'Exports',
  member: 'Members',
}

/** Where a search hit opens. */
export function hitPath(h: SearchHit): string {
  switch (h.kind) {
    case 'project':
      return h.project ? projectPath(h.project) : `/edit/${h.id}`
    case 'template':
      return `/templates?template=${encodeURIComponent(h.id)}`
    case 'media':
      return `/library?tab=assets&preview=${encodeURIComponent(h.id)}${h.at ? `&at=${Math.floor(h.at * 10) / 10}` : ''}`
    case 'voice':
      return '/voice'
    case 'export':
      return `/exports?q=${encodeURIComponent(h.title)}`
    case 'member':
      return '/space'
  }
}

/** Settings sections a command can jump to (ids are the Settings page's anchors). */
export function settingsSections(desktop: boolean): Array<{ id: string; title: string; keywords: string }> {
  return [
    { id: 'appearance', title: 'Appearance', keywords: 'theme dark light text size accent colour density motion' },
    { id: 'account', title: desktop ? 'Account & sync' : 'Account & devices', keywords: 'account sync cloud devices desktop link' },
    { id: 'ai', title: 'AI providers', keywords: 'ai model key claude anthropic openai gemini provider' },
    ...(desktop
      ? [
          { id: 'dictation', title: 'Dictation', keywords: 'dictation voice typing microphone' },
          { id: 'storage', title: 'Storage', keywords: 'storage folder disk data' },
          { id: 'about', title: 'About', keywords: 'about version' },
        ]
      : []),
  ]
}
