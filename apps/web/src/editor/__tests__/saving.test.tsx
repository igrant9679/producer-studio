// The editor's saving against a small fake server: base versions, 409s and the live update every write sends.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createProject, type ProjectSummary } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, api } from '../../lib/api'
import { flush, onProjectEvent } from '../persistence'
import { useEditor } from '../store'
import { TopBar } from '../TopBar'

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

beforeEach(() => {
  S().load({ project: createProject({ id: 'p1', name: 'First name' }), version: 3, projectId: 'p1', demo: false, workspaceId: 'w1' })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('renaming in the top bar', () => {
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
