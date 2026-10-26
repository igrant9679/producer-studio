import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InviteInfo, User, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import InvitePage from '../pages/InvitePage'

const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const personal: Workspace = { id: 'ws_me', name: "Sam's space", role: 'owner', personal: true, memberCount: 1 }
const team: Workspace = { id: 'ws_team', name: 'Launch crew', role: 'editor', personal: false, memberCount: 3 }
const invite = (over: Partial<InviteInfo> = {}): InviteInfo => ({
  workspaceId: team.id,
  workspaceName: team.name,
  role: 'editor',
  email: me.email,
  status: 'pending',
  expiresAt: Date.UTC(2026, 10, 1),
  forYou: true,
  member: false,
  ...over,
})

function show() {
  return render(
    <MemoryRouter initialEntries={['/invite/tok123']}>
      <Routes>
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/" element={<div>home page</div>} />
        <Route path="/login" element={<div>sign-in page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  useSession.setState({ status: 'ready', user: me, workspaces: [personal], workspaceId: personal.id })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<InvitePage>', () => {
  it('joins the space and switches to it', async () => {
    vi.spyOn(api, 'inviteInfo').mockResolvedValue(invite())
    const accept = vi.spyOn(api, 'acceptInvite').mockResolvedValue(team)
    vi.spyOn(api, 'workspaces').mockResolvedValue([personal, team])
    show()
    fireEvent.click(await screen.findByRole('button', { name: /Join Launch crew/ }))
    await screen.findByText('home page')
    expect(accept).toHaveBeenCalledWith('tok123')
    expect(useSession.getState().workspaceId).toBe(team.id)
  })

  it('tells someone signed in as another account whose invite it is', async () => {
    vi.spyOn(api, 'inviteInfo').mockResolvedValue(invite({ email: 'alex@example.com', forYou: false }))
    const accept = vi.spyOn(api, 'acceptInvite')
    const logout = vi.spyOn(api, 'logout').mockResolvedValue({ ok: true })
    show()
    expect(await screen.findByText('This invite is for alex@example.com')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Join/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Use another account/ }))
    await screen.findByText('sign-in page')
    expect(logout).toHaveBeenCalled()
    expect(accept).not.toHaveBeenCalled()
  })

  it('says when a link expired or was withdrawn', async () => {
    vi.spyOn(api, 'inviteInfo').mockResolvedValue(invite({ status: 'expired' }))
    show()
    expect(await screen.findByText('This invite has expired')).toBeTruthy()
    cleanup()
    vi.spyOn(api, 'inviteInfo').mockResolvedValue(invite({ status: 'revoked' }))
    show()
    expect(await screen.findByText('This invite was withdrawn')).toBeTruthy()
  })

  it('a link that no longer exists explains itself instead of a blank 404', async () => {
    const { HttpError } = await import('../../lib/api')
    vi.spyOn(api, 'inviteInfo').mockRejectedValue(new HttpError(404, { error: 'Invite not found', code: 'not_found' }))
    show()
    await waitFor(() => expect(screen.getByText('This invite link doesn’t work')).toBeTruthy())
  })
})
