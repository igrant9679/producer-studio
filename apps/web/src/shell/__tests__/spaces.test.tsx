import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Workspace } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { DeleteSpaceModal, RenameSpaceModal } from '../modals'

const personal: Workspace = { id: 'ws_me', name: "Sam's space", role: 'owner', personal: true, memberCount: 1 }
const team: Workspace = { id: 'ws_team', name: 'Launch crew', role: 'owner', personal: false, memberCount: 3 }

beforeEach(() => {
  localStorage.clear()
  useSession.setState({ status: 'ready', workspaces: [personal, team], workspaceId: team.id })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('session.refreshWorkspaces', () => {
  it('keeps the active space while it still exists', async () => {
    vi.spyOn(api, 'workspaces').mockResolvedValue([personal, { ...team, name: 'Renamed' }])
    await useSession.getState().refreshWorkspaces()
    expect(useSession.getState().workspaceId).toBe(team.id)
    expect(useSession.getState().workspaces[1].name).toBe('Renamed')
  })

  it('falls back to the personal space when the active one is gone', async () => {
    localStorage.setItem('ps.workspace', team.id)
    vi.spyOn(api, 'workspaces').mockResolvedValue([personal])
    await useSession.getState().refreshWorkspaces()
    expect(useSession.getState().workspaceId).toBe(personal.id)
    expect(localStorage.getItem('ps.workspace')).toBe(personal.id)
  })
})

describe('<RenameSpaceModal>', () => {
  it('saves the trimmed name and refreshes the list', async () => {
    const rename = vi.spyOn(api, 'renameWorkspace').mockResolvedValue({ ...team, name: 'Brand team' })
    vi.spyOn(api, 'workspaces').mockResolvedValue([personal, { ...team, name: 'Brand team' }])
    const onClose = vi.fn()
    render(<RenameSpaceModal ws={team} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Space name'), { target: { value: '  Brand team ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(rename).toHaveBeenCalledWith(team.id, 'Brand team')
    expect(useSession.getState().workspaces[1].name).toBe('Brand team')
  })
})

describe('<DeleteSpaceModal>', () => {
  it('stays disabled until the exact name is typed, then deletes and switches space', async () => {
    const del = vi.spyOn(api, 'deleteWorkspace').mockResolvedValue({ ok: true })
    vi.spyOn(api, 'workspaces').mockResolvedValue([personal])
    const onClose = vi.fn()
    render(<DeleteSpaceModal ws={team} onClose={onClose} />)
    expect(screen.getByText(/for all 3 members/)).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Delete space' }) as HTMLButtonElement
    const input = screen.getByLabelText(/to confirm/)
    expect(button.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'launch crew' } })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(del).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Launch crew' } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(del).toHaveBeenCalledWith(team.id)
    expect(useSession.getState().workspaceId).toBe(personal.id)
  })
})
