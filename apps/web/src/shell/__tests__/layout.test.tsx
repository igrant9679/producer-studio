// APP-19: below 1000 px the sidebar is a drawer behind a menu button, search is an icon, and the top bar's extra
// buttons are in the account menu. APP-17: every sidebar link has a name. The widths themselves need a browser;
// these check the behaviour the CSS hangs on.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { User, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Layout } from '../Layout'

const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const team: Workspace = { id: 'ws_team', name: 'Launch crew', role: 'owner', personal: false, memberCount: 3 }

function shell() {
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <Layout>
        <p>page</p>
      </Layout>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useSession.setState({ status: 'ready', user: me, workspaces: [team], workspaceId: team.id })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'not here' }), { status: 404 }))
  vi.spyOn(api, 'jobs').mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the sidebar drawer', () => {
  it('opens from the menu button, moves focus in, and closes on Escape with focus back on the button', () => {
    shell()
    const menu = screen.getByRole('button', { name: 'Menu' })
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(menu.getAttribute('aria-controls')).toBe(nav.id)
    expect(menu.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(menu)
    expect(menu.getAttribute('aria-expanded')).toBe('true')
    expect(nav.classList.contains('open')).toBe(true)
    expect(nav.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(nav.classList.contains('open')).toBe(false)
    expect(document.activeElement).toBe(menu)
  })

  it('closes when a page is picked', () => {
    shell()
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Templates' }))
    expect(screen.getByRole('navigation', { name: 'Main' }).classList.contains('open')).toBe(false)
  })

  it('names every link, for the icon-only sidebar too', () => {
    shell()
    const links = within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link')
    expect(links.length).toBeGreaterThan(8)
    for (const l of links) expect(l.getAttribute('aria-label')).toBeTruthy()
  })
})

describe('the top bar on a phone', () => {
  it('has a search icon that opens the search (the command palette) and closes it on Escape', () => {
    shell()
    const icon = screen.getByRole('button', { name: 'Search or jump to (Ctrl+K)' })
    icon.focus()
    fireEvent.click(icon)
    const box = screen.getByRole('combobox', { name: /Search projects, media, settings and commands/ })
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    expect(document.activeElement).toBe(box)
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
    expect(document.activeElement).toBe(icon)
  })

  it('keeps New video and Help in the account menu, with Sign out', () => {
    shell()
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    const menu = screen.getByRole('menu', { name: 'Account' })
    expect(within(menu).getByRole('menuitem', { name: 'New video' }).classList.contains('ps-narrow-only')).toBe(true)
    expect(within(menu).getByRole('menuitem', { name: 'Help & shortcuts' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeTruthy()
    // and the top-bar copies are the ones that hide at phone width
    expect(screen.getByRole('button', { name: /New video/, hidden: false }).classList.contains('ps-topbar-extra')).toBe(true)
  })
})

describe('the ? shortcut', () => {
  it('opens Help, but not over another dialog', () => {
    shell()
    fireEvent.keyDown(document.body, { key: '?' })
    expect(screen.getByRole('dialog', { name: 'Help' })).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Switch space/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create space' }))
    expect(screen.getByRole('dialog', { name: 'Create a space' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: '?' })
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Create a space' })).toBeTruthy()
  })
})
