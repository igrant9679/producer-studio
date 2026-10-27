// The editor's saving against a small fake server: base versions, 409s and the live update every write sends.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createProject, updateProject, type ProjectSummary } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, api } from '../../lib/api'
import { flush, onProjectEvent, startAutosave } from '../persistence'
import { useEditor } from '../store'
import { SaveErrorBanner, TopBar } from '../TopBar'

const S = () => useEditor.getState()

/** One project on a pretend server: saves need the current base version, and every write announces itself. */
function fakeServer(version: number) {
  const server = { version, doc: S().project }
  vi.spyOn(api, 'saveProject').mockImplementation(async (id, project, base) => {
    if (base !== server.version) throw new HttpError(409, { error: 'conflict', code: 'conflict', details: { version: server.version, project: server.doc } })
    server.version++
    server.doc = project
    void onProjectEvent({ id, version: server.version })
    return { version: server.version, updatedAt: Date.now() }
  })
  vi.spyOn(api, 'patchProject').mockImplementation(async (id, patch) => {
    server.version++
    server.doc = { ...server.doc, name: patch.name ?? server.doc.name }
    void onProjectEvent({ id, version: server.version })
    return { id, name: server.doc.name } as ProjectSummary
  })
  vi.spyOn(api, 'project').mockImplementation(async (id) => ({ project: server.doc, version: server.version, summary: { id, workspaceId: 'w1' } as ProjectSummary }))
  return server
}

let stopAutosave: () => void
beforeEach(() => {
  S().load({ project: createProject({ id: 'p1', name: 'First name' }), version: 3, projectId: 'p1', demo: false, workspaceId: 'w1' })
  stopAutosave = startAutosave()
})
afterEach(() => {
  stopAutosave()
  cleanup()
  vi.restoreAllMocks()
})

// the first render of the top bar is slow on a busy machine
describe('a save the server refuses', { timeout: 20_000 }, () => {
  it('says why, offers "Sign in again" after a sign-out, and saves once signed back in', async () => {
    const save = vi.spyOn(api, 'saveProject').mockRejectedValueOnce(new HttpError(401, { error: 'Not signed in', code: 'unauthorized' }))
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<MemoryRouter><TopBar /><SaveErrorBanner /></MemoryRouter>)
    S().commit(updateProject(S().project, { name: 'Edited' }), 'Rename project')
    await act(() => flush())
    expect(screen.getByText('Not saved')).toBeTruthy()
    expect(screen.queryByText('Offline')).toBeNull()
    expect(screen.getByRole('alert').textContent).toMatch(/signed out/i)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(open).toHaveBeenCalledWith('/login', '_blank')
    // back in this tab after signing in: the edit saves
    save.mockResolvedValueOnce({ version: 4, updatedAt: 1 })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await flush()
    })
    expect(S().saveState).toBe('saved')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the server’s reason for any other refusal, with Try again', async () => {
    const save = vi.spyOn(api, 'saveProject').mockRejectedValueOnce(new HttpError(413, { error: 'Request body too large', code: 'invalid' }))
    render(<MemoryRouter><SaveErrorBanner /></MemoryRouter>)
    S().commit(updateProject(S().project, { name: 'Edited' }), 'Rename project')
    await act(() => flush())
    expect(screen.getByRole('alert').textContent).toMatch(/too large/i)
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
    save.mockResolvedValueOnce({ version: 4, updatedAt: 1 })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })))
    await act(() => flush())
    expect(S().saveState).toBe('saved')
  })

  it('keeps project names to the 200 characters the server takes', async () => {
    fakeServer(3)
    render(<MemoryRouter><TopBar /></MemoryRouter>)
    const input = screen.getByLabelText('Project name') as HTMLInputElement
    expect(input.maxLength).toBe(200)
    fireEvent.change(input, { target: { value: 'x'.repeat(300) } })
    fireEvent.blur(input)
    expect(S().project.name).toHaveLength(200)
    await flush()
    expect(S().saveState).toBe('saved')
  })
})

describe('renaming in the top bar', { timeout: 20_000 }, () => {
  it('saves the new name with the autosave and raises no conflict', async () => {
    const server = fakeServer(3)
    render(<MemoryRouter><TopBar /></MemoryRouter>)
    const input = screen.getByLabelText('Project name')
    fireEvent.change(input, { target: { value: 'Second name' } })
    fireEvent.blur(input)
    await flush()
    await new Promise((r) => setTimeout(r, 0))
    expect(S().saveState).toBe('saved')
    expect(S().conflictVersion).toBeUndefined()
    expect(screen.queryByText('Conflict')).toBeNull()
    expect(server.doc.name).toBe('Second name')
    expect(S().version).toBe(server.version)
    // undo is an ordinary edit too: it saves, still without a conflict
    S().undo()
    await flush()
    expect(S().saveState).toBe('saved')
    expect(server.doc.name).toBe('First name')
  })
})
