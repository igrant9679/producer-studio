import type { AssetRecord, ProjectSummary } from '@producer/core'
import { describe, expect, it } from 'vitest'
import { filterAssets, filterProjects, mergeProjects, toggleInSet } from '../pages/libraryLogic'

const p = (id: string, over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id,
  workspaceId: 'w',
  name: id,
  width: 1920,
  height: 1080,
  duration: 10,
  isTemplate: false,
  trashed: false,
  kind: 'edit',
  updatedAt: 0,
  createdAt: 0,
  createdBy: 'u',
  ...over,
})

const list = [
  p('Alpha edit', { updatedAt: 3, createdAt: 1, duration: 30 }),
  p('beta producer', { kind: 'producer', updatedAt: 5, createdAt: 3, duration: 90 }),
  p('Gamma template', { isTemplate: true, updatedAt: 1, createdAt: 5, duration: 8 }),
  p('Delta trashed', { trashed: true, updatedAt: 9 }),
]

describe('filterProjects', () => {
  it('filters by type', () => {
    expect(filterProjects(list, { filter: 'edits', trashed: false }).map((x) => x.id)).toEqual(['Alpha edit'])
    expect(filterProjects(list, { filter: 'producer', trashed: false }).map((x) => x.id)).toEqual(['beta producer'])
    expect(filterProjects(list, { filter: 'templates', trashed: false }).map((x) => x.id)).toEqual(['Gamma template'])
  })

  it('separates trash from live projects', () => {
    expect(filterProjects(list, { trashed: true }).map((x) => x.id)).toEqual(['Delta trashed'])
    expect(filterProjects(list, { trashed: false })).toHaveLength(3)
  })

  it('searches case-insensitively and sorts', () => {
    expect(filterProjects(list, { q: 'BETA', trashed: false }).map((x) => x.id)).toEqual(['beta producer'])
    expect(filterProjects(list, { sort: 'updated', trashed: false }).map((x) => x.id)).toEqual(['beta producer', 'Alpha edit', 'Gamma template'])
    expect(filterProjects(list, { sort: 'created', trashed: false }).map((x) => x.id)).toEqual(['Gamma template', 'beta producer', 'Alpha edit'])
    expect(filterProjects(list, { sort: 'name', trashed: false }).map((x) => x.id)).toEqual(['Alpha edit', 'beta producer', 'Gamma template'])
    expect(filterProjects(list, { sort: 'duration', trashed: false })[0].id).toBe('beta producer')
  })
})

describe('mergeProjects', () => {
  it('de-duplicates by id with the later list winning', () => {
    const merged = mergeProjects([p('a', { name: 'old' }), p('b')], [p('a', { name: 'new', isTemplate: true })])
    expect(merged).toHaveLength(2)
    expect(merged.find((x) => x.id === 'a')?.name).toBe('new')
  })
})

describe('filterAssets', () => {
  const a = (id: string, kind: 'video' | 'audio' | 'image', origin: string, createdAt: number): AssetRecord => ({ asset: { id, kind, name: id, src: '' }, workspaceId: 'w', status: 'ready', origin, createdAt })
  const assets = [a('rec.mp4', 'video', 'upload', 1), a('vo', 'audio', 'tts', 3), a('logo.png', 'image', 'upload', 2)]
  it('filters by kind and generated origin, newest first', () => {
    expect(filterAssets(assets, {}).map((x) => x.asset.id)).toEqual(['vo', 'logo.png', 'rec.mp4'])
    expect(filterAssets(assets, { filter: 'video' }).map((x) => x.asset.id)).toEqual(['rec.mp4'])
    expect(filterAssets(assets, { filter: 'generated' }).map((x) => x.asset.id)).toEqual(['vo'])
    expect(filterAssets(assets, { q: 'LOGO' }).map((x) => x.asset.id)).toEqual(['logo.png'])
  })
})

describe('toggleInSet', () => {
  it('adds and removes without mutating', () => {
    const s = new Set(['a'])
    const t = toggleInSet(s, 'b')
    expect([...t]).toEqual(['a', 'b'])
    expect([...toggleInSet(t, 'a')]).toEqual(['b'])
    expect([...s]).toEqual(['a'])
  })
})
