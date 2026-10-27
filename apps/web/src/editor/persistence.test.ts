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
import { flush, keepBoth, loadInto, onProjectEvent, overwriteServer, reloadTheirs } from './persistence'
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

/** A promise the test settles by hand, standing in for a slow request. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const openSecond = (version = 10) => S().load({ project: createProject({ id: 'p2', name: 'second' }), version, projectId: 'p2', demo: false, workspaceId: 'w1' })

describe('answers for a project that is no longer open', () => {
  it('a slow save of the previous project leaves the next one alone', async () => {
    S().commit(updateProject(S().project, { name: 'edited' }), 'Rename')
    const slow = deferred<{ version: number; updatedAt: number }>()
    api.saveProject.mockReturnValueOnce(slow.promise)
    const saving = flush()
    openSecond()
    slow.resolve({ version: 4, updatedAt: 1 })
    await saving
    expect(S()).toMatchObject({ projectId: 'p2', version: 10, saveState: 'saved' })
    expect(S().project.name).toBe('second')
  })

  it("a 409 for the previous project neither raises a conflict here nor offers its content as 'theirs'", async () => {
    S().commit(updateProject(S().project, { name: 'edited' }), 'Rename')
    const slow = deferred<{ version: number; updatedAt: number }>()
    api.saveProject.mockReturnValueOnce(slow.promise)
    const saving = flush()
    openSecond()
    slow.reject(new HttpError(409, { error: 'conflict', details: { version: 7, project: doc('first, elsewhere') } }))
    await saving
    expect(S().saveState).toBe('saved')
    expect(S().conflictProject).toBeUndefined()
    api.project.mockResolvedValueOnce({ project: createProject({ id: 'p2', name: 'second' }), version: 10, summary: { workspaceId: 'w1' } })
    await reloadTheirs()
    expect(S().project.name).toBe('second')
  })

  it('reopening the same project drops the earlier visit’s save result', async () => {
    S().commit(updateProject(S().project, { name: 'edited' }), 'Rename')
    const slow = deferred<{ version: number; updatedAt: number }>()
    api.saveProject.mockReturnValueOnce(slow.promise)
    const saving = flush()
    S().load({ project: doc('mine'), version: 3, projectId: 'p1', demo: false, workspaceId: 'w1' })
    slow.resolve({ version: 4, updatedAt: 1 })
    await saving
    // the reloaded document is version 3's; claiming 4 would let the next save overwrite the edit unseen
    expect(S().version).toBe(3)
  })

  it('a live update that arrived during the old save is not replayed against the new project', async () => {
    S().commit(updateProject(S().project, { name: 'edited' }), 'Rename')
    const slow = deferred<{ version: number; updatedAt: number }>()
    api.saveProject.mockReturnValueOnce(slow.promise)
    const saving = flush()
    await onProjectEvent({ id: 'p1', version: 20 })
    openSecond()
    slow.resolve({ version: 4, updatedAt: 1 })
    await saving
    await new Promise((r) => setTimeout(r, 0))
    expect(api.project).not.toHaveBeenCalled()
    expect(S()).toMatchObject({ projectId: 'p2', version: 10, saveState: 'saved' })
  })

  it('a fetch started by a live update for the previous project is dropped', async () => {
    const slow = deferred<unknown>()
    api.project.mockReturnValueOnce(slow.promise)
    const handling = onProjectEvent({ id: 'p1', version: 5 })
    openSecond(2)
    slow.resolve({ project: doc('remote first'), version: 5, summary: { workspaceId: 'w1' } })
    await handling
    expect(S()).toMatchObject({ projectId: 'p2', version: 2, saveState: 'saved' })
    expect(S().project.name).toBe('second')
  })

  it('the project opened last wins when two loads overlap', async () => {
    const first = deferred<unknown>()
    api.project.mockReturnValueOnce(first.promise)
    api.project.mockResolvedValueOnce({ project: createProject({ id: 'p2', name: 'second' }), version: 10, summary: { workspaceId: 'w1' } })
    const a = loadInto('p1', false)
    await loadInto('p2', false)
    first.resolve({ project: doc('first'), version: 3, summary: { workspaceId: 'w1' } })
    await a
    expect(S().projectId).toBe('p2')
    expect(S().project.name).toBe('second')
  })
})
