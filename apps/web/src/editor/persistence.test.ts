import { createProject, updateProject } from '@producer/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  project: vi.fn(),
  saveProject: vi.fn(),
  createProject: vi.fn(),
}))
vi.mock('../lib/api', () => {
  class HttpError extends Error {
    status: number
    body: { error: string; details?: unknown }
    constructor(status: number, body: { error: string; details?: unknown }) {
      super(body.error)
      this.status = status
      this.body = body
    }
  }
  return { api, HttpError, mediaUrl: (id: string, v: string) => `/api/media/${id}/${v}` }
})

import { HttpError } from '../lib/api'
import { flush, keepBoth, onProjectEvent, overwriteServer, reloadTheirs } from './persistence'
import { useEditor } from './store'

const S = () => useEditor.getState()
const doc = (name: string) => createProject({ id: 'p1', name })

beforeEach(() => {
  vi.clearAllMocks()
  S().load({ project: doc('mine'), version: 3, projectId: 'p1', demo: false, workspaceId: 'w1' })
})

describe('save + sync', () => {
  it('saves with the base version and marks saved', async () => {
    S().commit(updateProject(S().project, { name: 'edited' }), 'Rename')
    api.saveProject.mockResolvedValueOnce({ version: 4, updatedAt: 1 })
    await flush()
    expect(api.saveProject).toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'edited' }), 3)
    expect(S().version).toBe(4)
    expect(S().saveState).toBe('saved')
  })

  it('409 stores the other replica and "reload theirs" adopts it', async () => {
    S().commit(updateProject(S().project, { name: 'edited' }), 'Rename')
    api.saveProject.mockRejectedValueOnce(new HttpError(409, { error: 'conflict', details: { version: 7, project: doc('theirs') } }))
    await flush()
    expect(S().saveState).toBe('conflict')
    expect(S().conflictVersion).toBe(7)
    await reloadTheirs()
    expect(S().project.name).toBe('theirs')
    expect(S().version).toBe(7)
    expect(S().saveState).toBe('saved')
    expect(S().history.past).toHaveLength(0)
  })

  it('"overwrite with mine" saves against the conflicting version', async () => {
    S().commit(updateProject(S().project, { name: 'edited' }), 'Rename')
    api.saveProject.mockRejectedValueOnce(new HttpError(409, { error: 'conflict', details: { version: 7 } }))
    await flush()
    api.saveProject.mockResolvedValueOnce({ version: 8, updatedAt: 1 })
    await overwriteServer()
    expect(api.saveProject).toHaveBeenLastCalledWith('p1', expect.objectContaining({ name: 'edited' }), 7)
    expect(S().saveState).toBe('saved')
    expect(S().version).toBe(8)
  })

  it('"keep both" creates a conflicted copy with the local doc', async () => {
    S().commit(updateProject(S().project, { name: 'edited' }), 'Rename')
    api.createProject.mockResolvedValueOnce({ project: { ...doc('x'), id: 'p2' }, version: 1, summary: {} })
    api.saveProject.mockResolvedValueOnce({ version: 2, updatedAt: 1 })
    const id = await keepBoth()
    expect(id).toBe('p2')
    expect(api.createProject).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', name: 'edited (conflicted copy)' }))
    expect(api.saveProject).toHaveBeenCalledWith('p2', expect.objectContaining({ id: 'p2', name: 'edited (conflicted copy)' }), 1)
  })

  it('SSE project event reloads silently when there are no local edits', async () => {
    api.project.mockResolvedValueOnce({ project: doc('remote'), version: 5, summary: { workspaceId: 'w1' } })
    await onProjectEvent({ id: 'p1', version: 5 })
    expect(S().project.name).toBe('remote')
    expect(S().version).toBe(5)
  })

  it('SSE project event with unsaved edits raises the conflict banner', async () => {
    S().commit(updateProject(S().project, { name: 'edited' }), 'Rename')
    await onProjectEvent({ id: 'p1', version: 5 })
    expect(S().saveState).toBe('conflict')
    expect(S().project.name).toBe('edited')
  })

  it('ignores events for other projects and stale versions', async () => {
    await onProjectEvent({ id: 'other', version: 99 })
    await onProjectEvent({ id: 'p1', version: 3 })
    expect(api.project).not.toHaveBeenCalled()
    expect(S().saveState).toBe('saved')
  })
})
