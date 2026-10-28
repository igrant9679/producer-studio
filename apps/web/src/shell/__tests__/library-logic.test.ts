// The Library's pure parts (A-12, A-13, A-15): views in the URL, shift-click ranges, the windowed grid, tags and a
// project made from a clip.
import type { Asset, ProjectSummary } from '@producer/core'
import { describe, expect, it } from 'vitest'
import { filterProjects, gridColumns, neighbour, parseTags, projectFromClip, readLibraryView, selectWithClick, tagCounts, windowRows, writeLibraryView } from '../pages/libraryLogic'

const p = (id: string, over: Partial<ProjectSummary> = {}): ProjectSummary => ({ id, workspaceId: 'w', name: id, width: 1920, height: 1080, duration: 1, isTemplate: false, trashed: false, kind: 'edit', updatedAt: 1, createdAt: 1, createdBy: 'u', ...over })

describe('views in the URL (A-12)', () => {
  it('reads every part, with defaults for what is missing or unknown', () => {
    expect(readLibraryView(new URLSearchParams(''))).toEqual({ tab: 'projects', q: '', type: 'all', media: 'all', sort: 'updated', view: 'grid', mine: false, show: 'projects' })
    expect(readLibraryView(new URLSearchParams('tab=assets&media=audio&sort=name&view=list&mine=1&tag=Q3&show=media&q=x'))).toEqual({ tab: 'assets', q: 'x', type: 'all', media: 'audio', sort: 'name', view: 'list', mine: true, tag: 'Q3', show: 'media' })
    expect(readLibraryView(new URLSearchParams('tab=nope&sort=bogus'), 'list')).toMatchObject({ tab: 'projects', sort: 'updated', view: 'list' })
  })

  it('writes only what differs from the defaults, and keeps other parameters', () => {
    const base = new URLSearchParams('preview=as_1&type=producer')
    expect(writeLibraryView(base, { type: 'all', sort: 'name', mine: true }).toString()).toBe('preview=as_1&sort=name&mine=1')
    expect(writeLibraryView(new URLSearchParams('mine=1&tag=x&q=a'), { mine: false, tag: undefined, q: '  ' }).toString()).toBe('')
    expect(writeLibraryView(new URLSearchParams(), { view: 'grid' }).toString()).toBe('view=grid')
  })

  it('filters by who made it and by tag', () => {
    const list = [p('a', { createdBy: 'me', tags: ['Launch'] }), p('b', { tags: ['launch', 'Q3'] }), p('c', { createdBy: 'me' })]
    expect(filterProjects(list, { createdBy: 'me' }).map((x) => x.id).sort()).toEqual(['a', 'c'])
    expect(filterProjects(list, { tag: 'LAUNCH' }).map((x) => x.id).sort()).toEqual(['a', 'b'])
    // the filter box also finds tags
    expect(filterProjects(list, { q: 'q3' }).map((x) => x.id)).toEqual(['b'])
    expect(tagCounts(list)).toEqual([{ tag: 'Launch', count: 2 }, { tag: 'Q3', count: 1 }])
    expect(parseTags(' a, ,b ,')).toEqual(['a', 'b'])
  })
})

describe('selection (A-13)', () => {
  const order = ['a', 'b', 'c', 'd', 'e']
  it('a click toggles one; a shift-click adds the range from the last one clicked, either way', () => {
    let s = selectWithClick(order, new Set(), undefined, 'b', false)
    expect([...s]).toEqual(['b'])
    s = selectWithClick(order, s, 'b', 'd', true)
    expect([...s].sort()).toEqual(['b', 'c', 'd'])
    s = selectWithClick(order, new Set(['e']), 'e', 'c', true)
    expect([...s].sort()).toEqual(['c', 'd', 'e'])
    // no anchor yet: a shift-click is a plain toggle
    expect([...selectWithClick(order, new Set(), undefined, 'c', true)]).toEqual(['c'])
    expect([...selectWithClick(order, new Set(['c']), 'c', 'c', false)]).toEqual([])
  })
})

describe('big libraries (A-15)', () => {
  it('fits columns like the CSS grid, and draws only the rows in view', () => {
    expect(gridColumns(1000, 220, 18)).toBe(4)
    expect(gridColumns(200, 220, 18)).toBe(1)
    // 1,000 cards, 4 a row, rows 200 px, 800 px in view, scrolled to row 50
    const w = windowRows({ scrollTop: 50 * 200, viewport: 800, top: 0, rowHeight: 200, count: 1000, cols: 4, overscan: 2 })
    expect(w).toEqual({ first: 48 * 4, last: 56 * 4, padTop: 48 * 200, padBottom: (250 - 56) * 200 })
    // at the top, with the grid starting lower on the page
    expect(windowRows({ scrollTop: 0, viewport: 600, top: 300, rowHeight: 200, count: 10, cols: 4 })).toEqual({ first: 0, last: 10, padTop: 0, padBottom: 0 })
    // past the end, the last row is still drawn
    expect(windowRows({ scrollTop: 1e6, viewport: 600, top: 0, rowHeight: 200, count: 10, cols: 4 }).last).toBe(10)
  })

  it('next / previous stop at the ends', () => {
    expect(neighbour(['a', 'b'], 'a', 1)).toBe('b')
    expect(neighbour(['a', 'b'], 'a', -1)).toBeUndefined()
    expect(neighbour(['a', 'b'], 'x', 1)).toBeUndefined()
  })

  it('a project from a clip has the clip on its timeline, sized to its picture', () => {
    const v = projectFromClip({ id: 'as_v', kind: 'video', name: 'Interview.mov', src: '', duration: 12, width: 1081, height: 1921 } as Asset)
    expect(v).toMatchObject({ name: 'Interview', width: 1082, height: 1922 })
    expect(v.tracks.flatMap((t) => t.items).map((i) => [i.type, (i as { assetId?: string }).assetId])).toEqual([['video', 'as_v']])
    const a = projectFromClip({ id: 'as_a', kind: 'audio', name: 'Voice.wav', src: '', duration: 5 } as Asset)
    expect(a).toMatchObject({ width: 1920, height: 1080 })
    expect(a.tracks.flatMap((t) => t.items).map((i) => i.type)).toEqual(['audio'])
  })
})
