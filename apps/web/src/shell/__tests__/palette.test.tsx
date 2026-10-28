// The command palette (A-10) and search everything (A-11): Ctrl+K from anywhere, keyboard only, commands that
// match what's typed, the space's search results (words said in a clip open its preview at that moment), what a
// viewer sees, a space switch and a 401.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SearchResults, User, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, HttpError } from '../../lib/api'
import { useAppearance } from '../../lib/appearance'
import { useSession } from '../../lib/session'
import { GlobalSearch } from '../palette/CommandPalette'
import { commandScore, hitPath, rankCommands } from '../palette/paletteLogic'

vi.setConfig({ testTimeout: 30_000 })

const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const mine: Workspace = { id: 'ws_me', name: 'Mine', role: 'owner', personal: true, memberCount: 1 }
const team: Workspace = { id: 'ws_team', name: 'Launch crew', role: 'editor', personal: false, memberCount: 3 }
const client: Workspace = { id: 'ws_client', name: 'Client review', role: 'viewer', personal: false, memberCount: 2 }

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search + l.hash}</div>
}
const newVideo = vi.fn()
const show = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <GlobalSearch onNewVideo={newVideo} />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
const where = () => screen.getByTestId('where').textContent
const box = () => screen.getByRole('combobox', { name: /Search projects, media, settings and commands/ })
const options = () => within(screen.getByRole('listbox', { name: 'Results' })).queryAllByRole('option')
const selected = () => options().find((o) => o.getAttribute('aria-selected') === 'true')

beforeEach(() => {
  useSession.setState({ status: 'ready', user: me, workspaces: [mine, team, client], workspaceId: mine.id })
  newVideo.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the command palette (A-10)', () => {
  it('opens on Ctrl+K with focus in the field, closes on Escape and gives focus back', () => {
    show()
    const before = screen.getByRole('button', { name: 'Search or jump to…' })
    before.focus()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    expect(document.activeElement).toBe(box())
    // Tab stays in the field
    fireEvent.keyDown(box(), { key: 'Tab' })
    expect(document.activeElement).toBe(box())
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(before)
    // ⌘K too, and again closes it
    fireEvent.keyDown(window, { key: 'K', metaKey: true })
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('filters commands as you type; arrows move, Enter runs (a Settings section, a page, new video)', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump to…' }))
    fireEvent.change(box(), { target: { value: 'appear' } })
    expect(options()[0].textContent).toMatch(/Settings: Appearance/)
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[0].id)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(where()).toBe('/settings#appearance')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(box(), { target: { value: 'trash' } })
    expect(selected()!.textContent).toMatch(/Trash/)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(where()).toBe('/library?tab=trash')

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(box(), { target: { value: 'new' } })
    const first = selected()!
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(selected()).not.toBe(first)
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(selected()).toBe(first)
    // up from the first wraps to the last
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(selected()).toBe(options()[options().length - 1])
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(selected()!.textContent).toMatch(/New video/)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(newVideo).toHaveBeenCalledTimes(1)
  })

  it('switches space and changes the theme', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump to…' }))
    fireEvent.change(box(), { target: { value: 'launch crew' } })
    fireEvent.click(screen.getByRole('option', { name: /Switch to Launch crew/ }))
    expect(useSession.getState().workspaceId).toBe('ws_team')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(box(), { target: { value: 'theme light' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(useAppearance.getState().prefs.theme).toBe('light')
  })

  it('a viewer gets no write commands', () => {
    useSession.setState({ workspaceId: client.id })
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump to…' }))
    const titles = options().map((o) => o.textContent)
    expect(titles.some((t) => /New video|Upload media|New from recording/.test(t ?? ''))).toBe(false)
    expect(titles.some((t) => /Library/.test(t ?? ''))).toBe(true)
  })
})

describe('search everything (A-11)', () => {
  const results: SearchResults = {
    q: 'widget',
    hits: [
      { kind: 'project', id: 'p_1', title: 'Widget launch', project: { id: 'p_1', workspaceId: 'ws_me', name: 'Widget launch', width: 1920, height: 1080, duration: 30, isTemplate: false, trashed: false, kind: 'edit', updatedAt: 1, createdAt: 1, createdBy: 'u' } },
      { kind: 'media', id: 'as_1', title: 'Interview.mov', assetId: 'as_1', detail: 'Said in the clip', snippet: 'We ship the blue widget on Friday', at: 72.4 },
      { kind: 'member', id: 'u_2', title: 'Widget Wanda', detail: 'w@example.com · editor' },
    ],
  }

  it('shows the space’s matches with the words said, and opens a clip at that moment', async () => {
    const search = vi.spyOn(api, 'search').mockResolvedValue(results)
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump to…' }))
    fireEvent.change(box(), { target: { value: 'widget' } })
    const said = await screen.findByRole('option', { name: /Interview\.mov/ })
    expect(said.textContent).toMatch(/1:12.*We ship the blue widget on Friday/)
    expect(search).toHaveBeenCalledWith('ws_me', 'widget', expect.anything())
    // results first, grouped
    expect(screen.getByText('Projects')).toBeTruthy()
    expect(screen.getByText('Members')).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(selected()).toBe(said)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(where()).toBe('/library?tab=assets&preview=as_1&at=72.4')
  })

  it('waits for a pause in typing, and searches the new space after a switch', async () => {
    const search = vi.spyOn(api, 'search').mockResolvedValue(results)
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump to…' }))
    fireEvent.change(box(), { target: { value: 'wi' } })
    fireEvent.change(box(), { target: { value: 'wid' } })
    fireEvent.change(box(), { target: { value: 'widget' } })
    await screen.findByRole('option', { name: /Widget launch/ })
    expect(search).toHaveBeenCalledTimes(1)
    search.mockResolvedValue({ q: 'widget', hits: [] })
    act(() => useSession.setState({ workspaceId: team.id }))
    await waitFor(() => expect(search).toHaveBeenLastCalledWith('ws_team', 'widget', expect.anything()))
    await waitFor(() => expect(screen.queryByRole('option', { name: /Widget launch/ })).toBeNull())
  })

  it('says so when the session has ended (401) instead of showing nothing', async () => {
    vi.spyOn(api, 'search').mockRejectedValue(new HttpError(401, { error: 'Not signed in', code: 'unauthorized' }))
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Search or jump to…' }))
    fireEvent.change(box(), { target: { value: 'widget' } })
    expect((await screen.findByRole('alert')).textContent).toMatch(/session ended/)
  })
})

describe('palette logic', () => {
  it('ranks a match at the start of a title first, needs every word, and keeps ties in order', () => {
    const cmds = [
      { title: 'Go to Library', group: 'Go to' },
      { title: 'Library', group: 'Go to' },
      { title: 'Upload media', group: 'Create', keywords: 'library import' },
    ]
    expect(rankCommands(cmds, 'lib').map((c) => c.title)).toEqual(['Library', 'Go to Library', 'Upload media'])
    expect(commandScore(cmds[2], 'upload nothing')).toBe(0)
    expect(rankCommands(cmds, '').length).toBe(3)
  })

  it('opens each kind of hit in its place', () => {
    expect(hitPath({ kind: 'project', id: 'p_9', title: 'x', project: { id: 'p_9', kind: 'producer', duration: 0 } as never })).toBe('/producer/p_9')
    expect(hitPath({ kind: 'export', id: 'ex_1', title: 'Launch cut' })).toBe('/exports?q=Launch%20cut')
    expect(hitPath({ kind: 'member', id: 'u', title: 'x' })).toBe('/space')
  })
})
