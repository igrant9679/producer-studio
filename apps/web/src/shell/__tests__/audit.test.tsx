// The accessibility audit for the app shell (R3-E): every control in the sidebar, the top bar and its menus, and a
// page, has a name a screen reader can say; each top-bar menu gives focus back to its button when it closes, and a
// menu closes on Tab (WAI-ARIA menu pattern).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SystemInfo, User, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Layout } from '../Layout'
import ToolsPage from '../pages/ToolsPage'
import { useSystem } from '../system'
import { MenuList, Popover } from '../ui'
import { unnamedControls } from './audit-helpers'

vi.setConfig({ testTimeout: 60_000 })
const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const team: Workspace = { id: 'ws_team', name: 'Launch crew', role: 'owner', personal: false, memberCount: 3 }
const info: SystemInfo = { mode: 'cloud', version: '1', ai: { provider: 'anthropic-api', available: true, detail: '' }, capabilities: { transcribe: true, tts: true, render: true } }

beforeEach(() => {
  useSession.setState({ status: 'ready', user: me, workspaces: [team], workspaceId: team.id })
  useSystem.setState({ info, loaded: true })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'not here' }), { status: 404 }))
  vi.spyOn(api, 'jobs').mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('shell menus close on Tab', () => {
  it('Tab on an item closes the menu, picks nothing, and moves on from its button; Shift+Tab goes back', () => {
    const pick = vi.fn()
    const Bar = () => (
      <>
        <button>Before</button>
        <Popover trigger={({ toggle, open }) => <button onClick={toggle} aria-expanded={open}>Account</button>}>
          {(close) => <MenuList label="Account" close={close} items={[{ label: 'Settings', onClick: pick }, { label: 'Sign out', onClick: pick }]} />}
        </Popover>
        <button>After</button>
      </>
    )
    render(<Bar />)
    const opener = screen.getByRole('button', { name: 'Account' })
    fireEvent.click(opener)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Settings' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }))
    fireEvent.click(opener)
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Before' }))
    expect(pick).not.toHaveBeenCalled()
  })
})

describe('every shell control has a name', () => {
  it('in the sidebar, the top bar, each of its menus, and a page', () => {
    render(
      <MemoryRouter initialEntries={['/tools']}>
        <Layout>
          <ToolsPage />
        </Layout>
      </MemoryRouter>,
    )
    const missing = unnamedControls().map((m) => `page: ${m}`)
    const header = document.querySelector<HTMLElement>('.ps-topbar')!
    const openers = Array.from(header.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')).filter((b) => b.getAttribute('aria-label') !== 'Menu')
    expect(openers.length).toBeGreaterThan(1)
    for (const b of openers) {
      act(() => b.focus())
      fireEvent.click(b)
      missing.push(...unnamedControls().map((m) => `${b.getAttribute('aria-label')}: ${m}`))
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      // closed, with focus back on its button
      expect(b.getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(b)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    missing.push(...unnamedControls().map((m) => `drawer: ${m}`))
    expect(missing).toEqual([])
  })
})
