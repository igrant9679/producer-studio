// The Library (A-12, A-13): views that stick in the URL (tab, filter, sort, view, "Created by me", tags), selection
// by click, shift-click ranges and the keyboard, and bulk actions (duplicate, template, tags, another space,
// download, trash), with viewers kept from writing.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ProjectSummary, User, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import LibraryPage from '../pages/LibraryPage'

vi.setConfig({ testTimeout: 60_000 })

const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const ws: Workspace = { id: 'ws_me', name: 'Me', role: 'owner', personal: false, memberCount: 2 }
const other: Workspace = { id: 'ws_team', name: 'Team', role: 'editor', personal: false, memberCount: 3 }
const viewer: Workspace = { id: 'ws_view', name: 'Client', role: 'viewer', personal: false, memberCount: 3 }
const p = (id: string, over: Partial<ProjectSummary> = {}): ProjectSummary => ({ id, workspaceId: ws.id, name: id, width: 1920, height: 1080, duration: 10, isTemplate: false, trashed: false, kind: 'edit', updatedAt: 100, createdAt: 1, createdBy: 'u_other', version: 1, ...over })
const list = [
  p('Alpha', { updatedAt: 9, createdBy: 'u_me', tags: ['Launch'] }),
  p('Bravo', { updatedAt: 8, kind: 'producer', duration: 30 }),
  p('Charlie', { updatedAt: 7, createdBy: 'u_me' }),
  p('Delta', { updatedAt: 6, tags: ['Launch', 'Q3'] }),
  p('Echo', { updatedAt: 5 }),
]

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search}</div>
}
const show = (path = '/library') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/library" element={<><LibraryPage /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
const where = () => screen.getByTestId('where').textContent ?? ''
const cardNames = () => screen.getAllByRole('button', { name: /^Open / }).map((b) => b.getAttribute('aria-label')!.slice(5))

beforeEach(() => {
  // the last view picked is remembered for a Library opened without one in its URL
  localStorage.removeItem('ps.libraryView')
  useSession.setState({ status: 'ready', user: me, workspaces: [ws, other, viewer], workspaceId: ws.id })
  vi.spyOn(api, 'projects').mockImplementation(async (_w, opts) => (opts?.templates ? [] : opts?.trashed ? [] : list))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('views that stick (A-12)', () => {
  it('a filter, sort or view chosen goes in the URL, and a URL opens that view', async () => {
    show()
    await screen.findByRole('button', { name: 'Open Alpha' })
    fireEvent.click(screen.getByRole('button', { name: 'Producer AI' }))
    expect(where()).toBe('/library?type=producer')
    expect(cardNames()).toEqual(['Bravo'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'name' } })
    fireEvent.click(screen.getByRole('button', { name: 'List view' }))
    expect(where()).toBe('/library?type=producer&sort=name&view=list')
    cleanup()

    // the same link, opened again
    show('/library?type=all&sort=name&view=list&mine=1')
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('button')[1].textContent)).toEqual(['Alpha', 'Charlie'])
    expect(screen.getByRole('button', { name: 'Created by me' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('filters by tag, and Clear filters goes back to everything', async () => {
    show('/library?tag=launch')
    await screen.findByRole('button', { name: 'Open Alpha' })
    expect(cardNames()).toEqual(['Alpha', 'Delta'])
    expect((screen.getByRole('combobox', { name: 'Tag' }) as HTMLSelectElement).value).toBe('')
    fireEvent.change(screen.getByRole('combobox', { name: 'Tag' }), { target: { value: 'Q3' } })
    expect(where()).toBe('/library?tag=Q3')
    expect(cardNames()).toEqual(['Delta'])
    cleanup()
    show('/library?q=zzz&mine=1')
    fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }))
    expect(where()).toBe('/library')
    expect(cardNames()).toHaveLength(5)
  })
})

describe('a big library (A-15)', () => {
  it('shows the first page while the rest is still loading', async () => {
    let finish!: (l: ProjectSummary[]) => void
    vi.spyOn(api, 'projects').mockImplementation((_w, opts) => {
      if (opts?.templates) return Promise.resolve([])
      opts?.onPage?.([list[0]])
      return new Promise((r) => (finish = r))
    })
    show()
    expect(await screen.findByRole('button', { name: 'Open Alpha' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/Loading more projects/)
    await act(async () => finish(list))
    expect(cardNames()).toHaveLength(5)
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('selection and bulk actions (A-13)', () => {
  it('shift-click selects a range; Ctrl+A selects all; Escape clears; Space selects from the keyboard', async () => {
    show()
    await screen.findByRole('button', { name: 'Open Alpha' })
    fireEvent.click(screen.getByRole('button', { name: 'Select Bravo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select Delta' }), { shiftKey: true })
    const bar = screen.getByRole('region', { name: 'Selection' })
    expect(bar.textContent).toMatch(/3 selected/)
    for (const n of ['Bravo', 'Charlie', 'Delta']) expect(screen.getByRole('button', { name: `Select ${n}` }).getAttribute('aria-pressed')).toBe('true')
    // a shift-click on a card selects too (it doesn't open it)
    fireEvent.click(screen.getByRole('button', { name: 'Open Echo' }), { shiftKey: true })
    expect(screen.getByRole('region', { name: 'Selection' }).textContent).toMatch(/4 selected/)
    expect(where()).toBe('/library')

    const grid = screen.getByRole('list', { name: 'Projects' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open Alpha' }), { key: 'a', ctrlKey: true })
    expect(screen.getByRole('region', { name: 'Selection' }).textContent).toMatch(/5 selected/)
    fireEvent.keyDown(grid, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull()

    const alpha = screen.getByRole('button', { name: 'Open Alpha' })
    alpha.focus()
    fireEvent.keyDown(alpha, { key: ' ' })
    expect(screen.getByRole('button', { name: 'Select Alpha' }).getAttribute('aria-pressed')).toBe('true')
    // arrow keys move between cards
    fireEvent.keyDown(alpha, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Bravo' }))
    fireEvent.keyDown(document.activeElement!, { key: ' ', shiftKey: true })
    expect(screen.getByRole('region', { name: 'Selection' }).textContent).toMatch(/2 selected/)
  })

  it('duplicates, saves as templates and moves to trash every selected project', async () => {
    const dup = vi.spyOn(api, 'duplicateProject').mockImplementation(async (id) => p(`${id} copy`, { updatedAt: 50 }))
    const patch = vi.spyOn(api, 'patchProject').mockImplementation(async (id) => p(id))
    show()
    await screen.findByRole('button', { name: 'Open Alpha' })
    fireEvent.click(screen.getByRole('button', { name: 'Select Alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select Charlie' }), { shiftKey: true })
    await act(async () => fireEvent.click(within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', { name: /Duplicate/ })))
    expect(dup.mock.calls.map((c) => c[0]).sort()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(await screen.findByRole('button', { name: 'Open Alpha copy' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Select Delta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select Echo' }))
    await act(async () => fireEvent.click(within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', { name: /Save as template/ })))
    expect(patch.mock.calls).toEqual([['Delta', { isTemplate: true }], ['Echo', { isTemplate: true }]])
    patch.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Select Delta' }))
    await act(async () => fireEvent.click(within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', { name: /Move to trash/ })))
    expect(patch).toHaveBeenCalledWith('Delta', { trashed: true })
    expect(screen.queryByRole('button', { name: 'Open Delta' })).toBeNull()
  })

  it('tags several projects at once, and copies or moves them to another space', async () => {
    const patch = vi.spyOn(api, 'patchProject').mockImplementation(async (id, b) => ({ ...p(id), tags: b.tags, version: 2 }))
    const copy = vi.spyOn(api, 'copyProject').mockImplementation(async (id) => ({ ...p(id), workspaceId: 'ws_team', missingMedia: 0 }))
    show()
    await screen.findByRole('button', { name: 'Open Alpha' })
    fireEvent.click(screen.getByRole('button', { name: 'Select Bravo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select Echo' }))
    fireEvent.click(within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', { name: /Tags/ }))
    const dialog = screen.getByRole('dialog', { name: 'Tags for 2 projects' })
    // the space's tags are offered
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add tag Launch' }))
    expect((within(dialog).getByRole('textbox', { name: 'Tags' }) as HTMLInputElement).value).toBe('Launch')
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /Save tags/ })))
    expect(patch.mock.calls).toEqual([['Bravo', { tags: ['Launch'] }], ['Echo', { tags: ['Launch'] }]])

    fireEvent.click(screen.getByRole('button', { name: 'Select Alpha' }))
    fireEvent.click(within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', { name: /Copy or move/ }))
    const move = screen.getByRole('dialog', { name: /Copy or move/ })
    // only spaces this person edits, not this one
    expect(within(move).getAllByRole('option').map((o) => o.textContent)).toEqual(['Team'])
    fireEvent.click(within(move).getByRole('radio', { name: /Move/ }))
    await act(async () => fireEvent.click(within(move).getByRole('button', { name: 'Move' })))
    expect(copy).toHaveBeenCalledWith('Alpha', { workspaceId: 'ws_team', move: true })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Alpha' })).toBeNull())
  })

  it('a viewer can select and download, but every write action is disabled', async () => {
    useSession.setState({ workspaceId: viewer.id })
    vi.spyOn(api, 'projects').mockResolvedValue(list.map((x) => ({ ...x, workspaceId: viewer.id })))
    vi.spyOn(api, 'exports').mockResolvedValue([])
    show()
    await screen.findByRole('button', { name: 'Open Alpha' })
    fireEvent.click(screen.getByRole('button', { name: 'Select Alpha' }))
    const bar = screen.getByRole('region', { name: 'Selection' })
    for (const name of [/Duplicate/, /Save as template/, /Tags/, /Copy or move/, /Move to trash/]) expect((within(bar).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(bar).getByRole('button', { name: /Download/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})
