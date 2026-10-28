// Pure filtering/sorting for the Library (unit-tested).
import { addItem, createAudioItem, createImageItem, createProject, createVideoItem, type Asset, type AssetRecord, type Project, type ProjectSummary } from '@producer/core'

export type ProjectFilter = 'all' | 'edits' | 'producer' | 'templates'
export type SortKey = 'updated' | 'created' | 'name' | 'duration'
export type AssetFilter = 'all' | 'video' | 'audio' | 'image' | 'generated'

export const PROJECT_FILTERS: Array<{ id: ProjectFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'edits', label: 'Edits' },
  { id: 'producer', label: 'Producer AI' },
  { id: 'templates', label: 'Templates' },
]

export const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: 'updated', label: 'Last edited' },
  { id: 'created', label: 'Date created' },
  { id: 'name', label: 'Name A–Z' },
  { id: 'duration', label: 'Longest first' },
]

export function matchesProjectFilter(p: ProjectSummary, f: ProjectFilter): boolean {
  switch (f) {
    case 'all':
      return true
    case 'edits':
      return p.kind === 'edit' && !p.isTemplate
    case 'producer':
      return p.kind === 'producer'
    case 'templates':
      return p.isTemplate
  }
}

export function sortProjects(list: ProjectSummary[], sort: SortKey): ProjectSummary[] {
  const out = list.slice()
  switch (sort) {
    case 'updated':
      return out.sort((a, b) => b.updatedAt - a.updatedAt)
    case 'created':
      return out.sort((a, b) => b.createdAt - a.createdAt)
    case 'name':
      return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
    case 'duration':
      return out.sort((a, b) => b.duration - a.duration)
  }
}

export function filterProjects(list: ProjectSummary[], opts: { filter?: ProjectFilter; q?: string; sort?: SortKey; trashed?: boolean; createdBy?: string; tag?: string }): ProjectSummary[] {
  const term = (opts.q ?? '').trim().toLowerCase()
  const f = opts.filter ?? 'all'
  const tag = opts.tag?.toLowerCase()
  const filtered = list.filter(
    (p) =>
      (opts.trashed === undefined || p.trashed === opts.trashed) &&
      matchesProjectFilter(p, f) &&
      (!opts.createdBy || p.createdBy === opts.createdBy) &&
      (!tag || (p.tags ?? []).some((t) => t.toLowerCase() === tag)) &&
      (!term || p.name.toLowerCase().includes(term) || (p.tags ?? []).some((t) => t.toLowerCase().includes(term))),
  )
  return sortProjects(filtered, opts.sort ?? 'updated')
}

// ---------------- views that stick (A-12) ----------------

export type LibraryTab = 'projects' | 'assets' | 'trash'
export type ViewMode = 'grid' | 'list'

/** What the Library shows, all of it in the URL (shareable, survives a reload). Defaults are left out of the URL. */
export interface LibraryView {
  tab: LibraryTab
  q: string
  /** Projects: which kind. */
  type: ProjectFilter
  /** Media: which kind. */
  media: AssetFilter
  sort: SortKey
  view: ViewMode
  /** Only what I made. */
  mine: boolean
  tag?: string
  /** The trash: projects or media. */
  show: 'projects' | 'media'
}

const TABS: LibraryTab[] = ['projects', 'assets', 'trash']
const PROJECT_TYPES: ProjectFilter[] = ['all', 'edits', 'producer', 'templates']
const MEDIA_TYPES: AssetFilter[] = ['all', 'video', 'audio', 'image', 'generated']
const SORT_KEYS: SortKey[] = ['updated', 'created', 'name', 'duration']

const pick = <T extends string>(v: string | null, allowed: T[], fallback: T): T => (v && (allowed as string[]).includes(v) ? (v as T) : fallback)

export function readLibraryView(p: URLSearchParams, fallbackView: ViewMode = 'grid'): LibraryView {
  return {
    tab: pick(p.get('tab'), TABS, 'projects'),
    q: p.get('q') ?? '',
    type: pick(p.get('type'), PROJECT_TYPES, 'all'),
    media: pick(p.get('media'), MEDIA_TYPES, 'all'),
    sort: pick(p.get('sort'), SORT_KEYS, 'updated'),
    view: pick(p.get('view'), ['grid', 'list'], fallbackView),
    mine: p.get('mine') === '1',
    ...(p.get('tag') ? { tag: p.get('tag')! } : {}),
    show: p.get('show') === 'media' ? 'media' : 'projects',
  }
}

/** The URL for a view changed by `patch` (other parameters kept; defaults dropped, except an explicit view). */
export function writeLibraryView(p: URLSearchParams, patch: Partial<LibraryView>): URLSearchParams {
  const n = new URLSearchParams(p)
  const set = (k: string, v: string | undefined, dflt?: string) => (v === undefined || v === '' || v === dflt ? n.delete(k) : n.set(k, v))
  if ('tab' in patch) set('tab', patch.tab, 'projects')
  if ('q' in patch) set('q', patch.q?.trim() ? patch.q : undefined)
  if ('type' in patch) set('type', patch.type, 'all')
  if ('media' in patch) set('media', patch.media, 'all')
  if ('sort' in patch) set('sort', patch.sort, 'updated')
  if ('view' in patch) set('view', patch.view)
  if ('mine' in patch) set('mine', patch.mine ? '1' : undefined)
  if ('tag' in patch) set('tag', patch.tag)
  if ('show' in patch) set('show', patch.show, 'projects')
  return n
}

/** The tags used in a list, most used first. */
export function tagCounts(list: Array<Pick<ProjectSummary, 'tags'>>): Array<{ tag: string; count: number }> {
  const m = new Map<string, { tag: string; count: number }>()
  for (const p of list)
    for (const t of p.tags ?? []) {
      const k = t.toLowerCase()
      const e = m.get(k) ?? { tag: t, count: 0 }
      e.count++
      m.set(k, e)
    }
  return [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** Tags typed into one field, comma separated. */
export function parseTags(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

// ---------------- selection (A-13) ----------------

/**
 * A click that selects: a plain click toggles one item, a shift-click selects everything between the last item
 * clicked (the anchor) and this one, in the order shown, adding to what is selected.
 */
export function selectWithClick(order: string[], sel: Set<string>, anchor: string | undefined, id: string, shift: boolean): Set<string> {
  if (!shift || !anchor || anchor === id) return toggleInSet(sel, id)
  const a = order.indexOf(anchor)
  const b = order.indexOf(id)
  if (a < 0 || b < 0) return toggleInSet(sel, id)
  const n = new Set(sel)
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) n.add(order[i])
  return n
}

// ---------------- big libraries (A-15) ----------------

/** Columns a grid of `minCol`-wide cards fits in `width` (CSS: repeat(auto-fill, minmax(minCol, 1fr))). */
export function gridColumns(width: number, minCol: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (minCol + gap)))
}

/**
 * Which rows of a grid to draw: those in view (plus `overscan` rows each side), and the space to leave above and
 * below them. `top` is where the grid starts in the scrolled area.
 */
export function windowRows(o: { scrollTop: number; viewport: number; top: number; rowHeight: number; count: number; cols: number; overscan?: number }): { first: number; last: number; padTop: number; padBottom: number } {
  const rows = Math.ceil(o.count / o.cols)
  if (!rows || o.rowHeight <= 0) return { first: 0, last: o.count, padTop: 0, padBottom: 0 }
  const over = o.overscan ?? 2
  const from = Math.max(0, Math.floor((o.scrollTop - o.top) / o.rowHeight) - over)
  const to = Math.min(rows, Math.ceil((o.scrollTop - o.top + o.viewport) / o.rowHeight) + over)
  const start = Math.min(from, Math.max(0, to - 1))
  return { first: start * o.cols, last: Math.min(o.count, to * o.cols), padTop: start * o.rowHeight, padBottom: Math.max(0, rows - to) * o.rowHeight }
}

/** The next / previous item for a preview's arrows (none past either end). */
export function neighbour<T>(list: T[], current: T, step: 1 | -1): T | undefined {
  const i = list.indexOf(current)
  return i < 0 ? undefined : list[i + step]
}

/** A new project with the clip on its timeline, sized to the clip's picture ("Use in a new project"). */
export function projectFromClip(a: Asset): Project {
  const portrait = a.width && a.height ? a.width < a.height : false
  const width = a.width && a.height ? a.width : portrait ? 1080 : 1920
  const height = a.width && a.height ? a.height : portrait ? 1920 : 1080
  const even = (n: number) => Math.max(16, Math.min(8192, Math.round(n / 2) * 2))
  let p = createProject({ name: a.name.replace(/\.[a-z0-9]{2,5}$/i, '') || 'Untitled project', width: even(width), height: even(height) })
  p = { ...p, assets: { ...p.assets, [a.id]: a } }
  const item = a.kind === 'video' ? createVideoItem(a, 0) : a.kind === 'image' ? createImageItem(a, 0) : createAudioItem(a, 0)
  return addItem(p, item)
}

/** Merge project lists (e.g. regular + templates responses) de-duplicated by id, last write wins. */
export function mergeProjects(...lists: ProjectSummary[][]): ProjectSummary[] {
  const m = new Map<string, ProjectSummary>()
  for (const l of lists) for (const p of l) m.set(p.id, p)
  return [...m.values()]
}

export function filterAssets(list: AssetRecord[], opts: { filter?: AssetFilter; q?: string; sort?: SortKey }): AssetRecord[] {
  const term = (opts.q ?? '').trim().toLowerCase()
  const f = opts.filter ?? 'all'
  const out = list.filter((a) => {
    if (term && !a.asset.name.toLowerCase().includes(term)) return false
    if (f === 'all') return true
    if (f === 'generated') return a.origin !== 'upload'
    return a.asset.kind === f
  })
  switch (opts.sort ?? 'updated') {
    case 'name':
      return out.sort((a, b) => a.asset.name.localeCompare(b.asset.name, undefined, { sensitivity: 'base', numeric: true }))
    case 'duration':
      return out.sort((a, b) => (b.asset.duration ?? 0) - (a.asset.duration ?? 0))
    default:
      return out.sort((a, b) => b.createdAt - a.createdAt)
  }
}

export function toggleInSet<T>(set: Set<T>, v: T): Set<T> {
  const n = new Set(set)
  if (n.has(v)) n.delete(v)
  else n.add(v)
  return n
}

export const ORIGIN_LABEL: Record<string, string> = { upload: 'Upload', tts: 'Voiceover', render: 'Export', freeze: 'Freeze frame', ai: 'AI generated' }
