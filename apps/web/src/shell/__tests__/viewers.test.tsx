// APP-14: a viewer sees write actions disabled, saying who can. APP-13 / APP-35: only owners invite, never on a
// personal space, and an Owner invite is confirmed first.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProjectSummary, User, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Layout } from '../Layout'
import { InviteForm, InviteModal } from '../modals'
import LibraryPage from '../pages/LibraryPage'
import SpacePage from '../pages/SpacePage'
import { ShellRoutes } from '../ShellRoutes'
import { useEditGate } from '../ui'

const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const personal: Workspace = { id: 'ws_me', name: "Sam's space", role: 'owner', personal: true, memberCount: 1 }
const team: Workspace = { id: 'ws_team', name: 'Launch crew', role: 'owner', personal: false, memberCount: 3 }
const review: Workspace = { id: 'ws_review', name: 'Client review', role: 'viewer', personal: false, memberCount: 4 }
const crew: Workspace = { id: 'ws_crew', name: 'Edit crew', role: 'editor', personal: false, memberCount: 4 }
const project: ProjectSummary = {
  id: 'p_1',
  workspaceId: review.id,
  name: 'Launch cut',
  kind: 'edit',
  width: 1920,
  height: 1080,
  duration: 30,
  version: 1,
  createdAt: 0,
  updatedAt: Date.now(),
  trashed: false,
  isTemplate: false,
} as unknown as ProjectSummary

const VIEWER_TIP = 'Only owners and editors of “Client review” can do this. You’re a viewer.'

function useIn(ws: Workspace) {
  useSession.setState({ status: 'ready', user: me, workspaces: [personal, team, review, crew], workspaceId: ws.id })
}

beforeEach(() => {
  localStorage.clear()
  // the shell's background calls (system info, jobs) answer "nothing here"
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'not here' }), { status: 404 }))
  vi.spyOn(api, 'jobs').mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function GateProbe() {
  const g = useEditGate()
  return <button {...g.props}>Write something</button>
}

describe('useEditGate', () => {
  it('lets owners and editors act, and disables the action for a viewer with who can', () => {
    useIn(crew)
    const { unmount } = render(<GateProbe />)
    expect((screen.getByRole('button', { name: 'Write something' }) as HTMLButtonElement).disabled).toBe(false)
    unmount()
    useIn(review)
    render(<GateProbe />)
    const b = screen.getByRole('button', { name: 'Write something' }) as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(b.getAttribute('data-tip')).toBe(VIEWER_TIP)
  })
})

describe('the shell for a viewer', () => {
  it('disables Create new and New video, and says what a viewer can do', async () => {
    useIn(review)
    render(
      <MemoryRouter>
        <Layout>
          <p>page</p>
        </Layout>
      </MemoryRouter>,
    )
    const create = screen.getByRole('button', { name: 'Create new' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    expect(create.getAttribute('data-tip')).toBe(VIEWER_TIP)
    expect((screen.getByRole('button', { name: /New video/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('note').textContent).toMatch(/You’re a viewer in “Client review”/)
  })

  it('gives a viewer who opens Producer AI who can use it instead of the wizard', async () => {
    useIn(review)
    render(
      <MemoryRouter initialEntries={['/producer/new']}>
        <ShellRoutes />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Producer AI needs an editor')).toBeTruthy()
    expect(screen.getAllByText(VIEWER_TIP).length).toBeGreaterThan(0)
  })
})

describe('the Library for a viewer', () => {
  it('can open a project but finds rename, duplicate, share and trash disabled, saying who can', async () => {
    useIn(review)
    vi.spyOn(api, 'projects').mockResolvedValue([project])
    render(
      <MemoryRouter initialEntries={['/library']}>
        <Routes>
          <Route path="/library" element={<LibraryPage />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Launch cut' }))
    expect((screen.getByRole('menuitem', { name: 'Open in editor' }) as HTMLButtonElement).disabled).toBe(false)
    for (const name of ['Rename', 'Duplicate', 'Copy share link', 'Save as template', 'Move to trash']) {
      const item = screen.getByRole('menuitem', { name }) as HTMLButtonElement
      expect(item.disabled).toBe(true)
      expect(item.getAttribute('data-tip')).toBe(VIEWER_TIP)
    }
  })
})

describe('invites', () => {
  it('aren’t offered on a personal space', () => {
    useIn(personal)
    render(<InviteModal onClose={() => undefined} />)
    expect(screen.getByText(/This is your personal space, just for you/)).toBeTruthy()
    expect(screen.queryByLabelText('Email to invite')).toBeNull()
  })

  it('are for owners only', () => {
    useIn(crew)
    render(<InviteModal onClose={() => undefined} />)
    expect(screen.getByText(/Only owners of Edit crew can invite people/)).toBeTruthy()
    expect(screen.queryByLabelText('Email to invite')).toBeNull()
  })

  it('in the sidebar: hidden on a personal space, disabled for a non-owner, there for an owner', () => {
    const navInvite = () => screen.queryByRole('button', { name: 'Invite members' }) as HTMLButtonElement | null
    const shell = () =>
      render(
        <MemoryRouter>
          <Layout>
            <p>page</p>
          </Layout>
        </MemoryRouter>,
      )
    useIn(personal)
    const a = shell()
    expect(navInvite()).toBeNull()
    a.unmount()
    useIn(crew)
    const b = shell()
    expect(navInvite()!.disabled).toBe(true)
    expect(navInvite()!.getAttribute('data-tip')).toBe('Only owners of this space can invite people')
    b.unmount()
    useIn(team)
    shell()
    expect(navInvite()!.disabled).toBe(false)
  })

  it('on the Members page of a personal space: none, with a way to a team space', async () => {
    useIn(personal)
    vi.spyOn(api, 'members').mockResolvedValue([{ userId: me.id, name: me.name, email: me.email, role: 'owner' }])
    vi.spyOn(api, 'invites').mockResolvedValue([])
    render(
      <MemoryRouter>
        <SpacePage />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Personal spaces are just for you/)).toBeTruthy()
    expect(screen.queryByLabelText('Email to invite')).toBeNull()
    expect(screen.getByRole('button', { name: /Create a team space/ })).toBeTruthy()
  })

  it('say they make a link, and ask before making an Owner invite', async () => {
    useIn(team)
    const invite = vi.spyOn(api, 'invite').mockResolvedValue({ ok: true, inviteUrl: '/invite/tok', expiresAt: Date.now() + 1000 })
    render(<InviteForm workspaceId={team.id} />)
    fireEvent.change(screen.getByLabelText('Email to invite'), { target: { value: 'kim@example.com' } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'owner' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create invite link' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Invite kim@example.com as an owner?' })
    expect(confirm).toBeTruthy()
    expect(invite).not.toHaveBeenCalled()
    // opens on Cancel
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create owner invite' }))
    await waitFor(() => expect(invite).toHaveBeenCalledWith(team.id, 'kim@example.com', 'owner'))
    expect(await screen.findByText(/Invite link ready/)).toBeTruthy()
  })

  it('make an editor invite without asking', async () => {
    useIn(team)
    const invite = vi.spyOn(api, 'invite').mockResolvedValue({ ok: true, inviteUrl: '/invite/tok', expiresAt: Date.now() + 1000 })
    render(<InviteForm workspaceId={team.id} />)
    fireEvent.change(screen.getByLabelText('Email to invite'), { target: { value: 'kim@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create invite link' }))
    await waitFor(() => expect(invite).toHaveBeenCalledWith(team.id, 'kim@example.com', 'editor'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
