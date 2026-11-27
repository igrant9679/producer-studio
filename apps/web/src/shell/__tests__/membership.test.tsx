// Joining from the membership website: the one-time sign-in link signs the member in and opens their space, asking a
// website-made account for its first password; a space's settings show its membership, and an owner can get one for a
// space made in the app (a claim carried to the website).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MeResponse, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { accountApi } from '../../lib/accountApi'
import { useSession } from '../../lib/session'
import { LinkPage } from '../AccountAuthPages'
import { SpaceMembership } from '../pages/SpaceMembership'

const ws: Workspace = { id: 'ws_maya', name: 'Maya Films', role: 'owner', personal: true, memberCount: 1 }
const me = (needsPassword: boolean): MeResponse => ({ user: { id: 'u_maya', email: 'maya@example.com', name: 'Maya Lee', avatarColor: '#ff5a5f' } as MeResponse['user'], workspaces: [ws], ...(needsPassword ? { needsPassword: true } : {}) })

function showLink(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/link/:token" element={<LinkPage />} />
        <Route path="/" element={<div>Home page</div>} />
        <Route path="/login" element={<div>Sign-in page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useSession.setState({ status: 'anon', workspaces: [], workspaceId: undefined, needsPassword: undefined })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('the sign-in link from the membership website', () => {
  it('signs a website-made account in, asks for its first password, then opens the space', async () => {
    const link = vi.spyOn(accountApi, 'signInLink').mockResolvedValue(me(true))
    vi.spyOn(api, 'me').mockResolvedValue(me(true))
    const set = vi.spyOn(accountApi, 'changePassword').mockResolvedValue({ ok: true })
    window.history.replaceState(null, '', '/link/tok123?ws=ws_maya')
    showLink('/link/tok123?ws=ws_maya')
    expect(await screen.findByText(/You’re signed in as maya@example\.com/)).toBeTruthy()
    expect(link).toHaveBeenCalledTimes(1)
    expect(link).toHaveBeenCalledWith('tok123')
    expect(useSession.getState().workspaceId).toBe('ws_maya')
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: /Set password and open/ }))
    expect(await screen.findByText('Use at least 8 characters')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-good-password' } })
    fireEvent.click(screen.getByRole('button', { name: /Set password and open/ }))
    await screen.findByText('Home page')
    expect(set).toHaveBeenCalledWith('', 'a-good-password')
    expect(useSession.getState().needsPassword).toBe(false)
  })

  it('an account that has a password goes straight in; a used or expired link says what to do', async () => {
    vi.spyOn(accountApi, 'signInLink').mockResolvedValue(me(false))
    vi.spyOn(api, 'me').mockResolvedValue(me(false))
    showLink('/link/tok-ok')
    await screen.findByText('Home page')
    cleanup()
    const { HttpError } = await import('../../lib/api')
    vi.spyOn(accountApi, 'signInLink').mockRejectedValue(new HttpError(410, { error: 'This link has already been used.' }))
    showLink('/link/tok-used')
    expect(await screen.findByText(/This link has already been used\. Sign-in links work once and for 15 minutes/)).toBeTruthy()
  })
})

describe('Settings → Space: membership', () => {
  it('shows an active membership and where to manage it', async () => {
    vi.spyOn(api, 'membership').mockResolvedValue({ membership: { source: 'meyousocial', plan: 'founder', status: 'active', seats: 2, updatedAt: 1 }, membershipUrl: 'https://www.meyousocial.com/join/', canClaim: false })
    render(<SpaceMembership workspaceId="ws_maya" />)
    expect(await screen.findByText('Founder · Active · 2 seats')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Manage on the membership website/ }).getAttribute('href')).toBe('https://www.meyousocial.com/join/')
    expect(screen.queryByRole('button', { name: /Get a membership/ })).toBeNull()
  })

  it('an owner of a space without one goes to the website with a claim; nothing shows where memberships aren’t set up', async () => {
    vi.spyOn(api, 'membership').mockResolvedValue({ membershipUrl: 'https://www.meyousocial.com/join/', canClaim: true })
    const claim = vi.spyOn(api, 'claimMembership').mockResolvedValue({ url: 'https://www.meyousocial.com/join/?ps_claim=v1.x', claim: 'v1.x', expiresAt: 1 })
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    try {
      render(<SpaceMembership workspaceId="ws_maya" />)
      fireEvent.click(await screen.findByRole('button', { name: /Get a membership for this space/ }))
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://www.meyousocial.com/join/?ps_claim=v1.x'))
      expect(claim).toHaveBeenCalledWith('ws_maya')
    } finally {
      vi.unstubAllGlobals()
    }
    cleanup()
    vi.spyOn(api, 'membership').mockResolvedValue({ membershipUrl: 'https://www.meyousocial.com/join/', canClaim: false })
    const { container } = render(<SpaceMembership workspaceId="ws_maya" />)
    await waitFor(() => expect(api.membership).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})

describe('the welcome step after signing up in the app', () => {
  it('a new account made in the app goes to /welcome; one that came to accept an invite goes there instead', async () => {
    const { AuthPage } = await import('../AuthPage')
    const signupApi = vi.spyOn(api, 'signup').mockImplementation(async () => me(false))
    const fill = () => {
      fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Maya Lee' } })
      fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'maya@example.com' } })
      fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'a-good-password' } })
      fireEvent.click(screen.getByRole('button', { name: /create account/i }))
    }
    const at = (path: string) =>
      render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/signup" element={<AuthPage mode="signup" />} />
            <Route path="/welcome" element={<div>Welcome step</div>} />
            <Route path="/invite/:token" element={<div>Invite page</div>} />
            <Route path="/" element={<div>Home page</div>} />
          </Routes>
        </MemoryRouter>,
      )
    at('/signup')
    fill()
    expect(await screen.findByText('Welcome step')).toBeTruthy()
    expect(signupApi).toHaveBeenCalledWith('maya@example.com', 'a-good-password', 'Maya Lee')
    cleanup()
    useSession.setState({ status: 'anon', workspaces: [], workspaceId: undefined })
    at('/signup?next=%2Finvite%2Ftok9')
    fill()
    expect(await screen.findByText('Invite page')).toBeTruthy()
  })

  it('offers a membership where memberships are set up, your own key, or free; a membership goes to the website with a claim', async () => {
    const { default: WelcomePage } = await import('../pages/WelcomePage')
    useSession.setState({ status: 'ready', user: me(false).user, workspaces: [ws], workspaceId: 'ws_maya' })
    vi.spyOn(api, 'membership').mockResolvedValue({ membershipUrl: 'https://www.meyousocial.com/membership/', canClaim: true })
    const claim = vi.spyOn(api, 'claimMembership').mockResolvedValue({ url: 'https://www.meyousocial.com/membership/?ps_claim=v1.y', claim: 'v1.y', expiresAt: 1 })
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    const show = () =>
      render(
        <MemoryRouter initialEntries={['/welcome']}>
          <Routes>
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/settings" element={<div>Settings page</div>} />
            <Route path="/" element={<div>Home page</div>} />
          </Routes>
        </MemoryRouter>,
      )
    try {
      show()
      expect(await screen.findByText('Welcome, Maya')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: /Choose a plan/ }))
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://www.meyousocial.com/membership/?ps_claim=v1.y'))
      expect(claim).toHaveBeenCalledWith('ws_maya')
    } finally {
      vi.unstubAllGlobals()
    }
    cleanup()
    // where memberships aren't set up: a key, or free
    vi.spyOn(api, 'membership').mockResolvedValue({ membershipUrl: 'https://www.meyousocial.com/', canClaim: false })
    show()
    await screen.findByText('Use my own AI key')
    expect(screen.queryByText('Get a membership')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Add a key/ }))
    expect(await screen.findByText('Settings page')).toBeTruthy()
    cleanup()
    show()
    fireEvent.click(await screen.findByRole('button', { name: /Go to my space/ }))
    expect(await screen.findByText('Home page')).toBeTruthy()
  })
})
