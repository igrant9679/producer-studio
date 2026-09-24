// Pure filtering/sorting for the Library (unit-tested).
import type { AssetRecord, ProjectSummary } from '@producer/core'

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

export function filterProjects(list: ProjectSummary[], opts: { filter?: ProjectFilter; q?: string; sort?: SortKey; trashed?: boolean }): ProjectSummary[] {
  const term = (opts.q ?? '').trim().toLowerCase()
  const f = opts.filter ?? 'all'
  const filtered = list.filter((p) => (opts.trashed === undefined || p.trashed === opts.trashed) && matchesProjectFilter(p, f) && (!term || p.name.toLowerCase().includes(term)))
  return sortProjects(filtered, opts.sort ?? 'updated')
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
