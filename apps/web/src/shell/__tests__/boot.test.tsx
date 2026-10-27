// QA-7: the first paint is the app shell with placeholders, not a bare "Loading…". QA-6: React doesn't start a sign-in
// check of its own (main.tsx starts the one check before mounting). APP-36: a crafted ?next= can't leave the app,
// and a crash anywhere shows a way out.
import { act, cleanup, render, screen } from '@testing-library/react'
import type { User, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../App'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { safeNext } from '../AuthPage'
import { AppErrorBoundary } from '../boot'

const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const ws: Workspace = { id: 'ws_me', name: "Sam's space", role: 'owner', personal: true, memberCount: 1 }

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'not here' }), { status: 404 }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('first load', () => {
  it('shows the app shell with placeholders while the sign-in check is out, and starts no check of its own', () => {
    useSession.setState({ status: 'loading', user: undefined, workspaces: [] })
    const check = vi.spyOn(api, 'me')
    render(
      <MemoryRouter initialEntries={['/library']}>
        <App />
      </MemoryRouter>,
    )
    const shell = screen.getByRole('status', { name: 'Loading Producer Studio' })
    expect(shell.querySelector('.ps-nav .ps-logo')).toBeTruthy()
    expect(shell.querySelectorAll('.skeleton').length).toBeGreaterThan(5)
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(check).not.toHaveBeenCalled()
  })
})

describe('the editor when the session ends', () => {
  it('stays on screen (its unsaved changes with it) instead of jumping to sign-in', async () => {
    useSession.setState({ status: 'ready', user: me, workspaces: [ws], workspaceId: ws.id })
    vi.spyOn(api, 'me').mockRejectedValue(new Error('offline'))
    render(
      <MemoryRouter initialEntries={['/edit/p_1']}>
        <App />
      </MemoryRouter>,
    )
    act(() => useSession.setState({ status: 'anon', user: undefined, workspaces: [], workspaceId: undefined, signedOutReason: 'expired' }))
    await act(async () => new Promise((r) => setTimeout(r, 50)))
    expect(screen.queryByRole('heading', { name: 'Sign in to your studio' })).toBeNull()
  })

  it('but a signed-out visit to an editor link goes to sign-in', async () => {
    useSession.setState({ status: 'anon', user: undefined, workspaces: [], workspaceId: undefined, signedOutReason: undefined })
    render(
      <MemoryRouter initialEntries={['/edit/p_1']}>
        <App />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: 'Sign in to your studio' })).toBeTruthy()
  })
})

describe('safeNext', () => {
  it('keeps app paths, resolved as the browser will open them', () => {
    expect(safeNext('/library?tab=assets#top')).toBe('/library?tab=assets#top')
    expect(safeNext('/edit/p_1/../p_2')).toBe('/edit/p_2')
  })

  it('refuses anything that leaves the app', () => {
    for (const next of ['https://evil.test', '//evil.test', '/\\evil.test', '/\t/evil.test', '/\n/evil.test', '\\\\evil.test', 'javascript:alert(1)', '/%0a/x\u0000']) expect(safeNext(next)).toBe('/')
  })

  it('doesn’t loop back to sign-in', () => {
    expect(safeNext('/login')).toBe('/')
    expect(safeNext('/signup?next=/x')).toBe('/')
    expect(safeNext('/loginhelp')).toBe('/loginhelp')
  })
})

describe('<AppErrorBoundary>', () => {
  it('turns a crash into a screen with Reload and Home', () => {
    const Boom = () => {
      throw new Error('kaboom')
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    )
    expect(screen.getByRole('alert').textContent).toMatch(/Something went wrong/)
    expect(screen.getByRole('button', { name: /Reload/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/')
  })
})
