// E-2: unsaved edits kept in this browser and offered back, and save states that say what is really happening.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addItem, createProject, createTextItem, updateProject, type Project, type ProjectSummary } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { readJournal } from '../journal'
import { JOURNAL_MS, RETRY_MS, flush, loadInto, startAutosave } from '../persistence'
import { useEditor } from '../store'
import { JournalBanner, SaveErrorBanner, TopBar } from '../TopBar'

const S = () => useEditor.getState()
const BASE = createProject({ id: 'p1' })
/** The same project (same track ids) with a name and background. */
const doc = (name: string, background = '#000000'): Project => ({ ...BASE, name, background, createdAt: 1, updatedAt: 1 })
const summary = { id: 'p1', workspaceId: 'w1' } as ProjectSummary
const me = { id: 'u1', email: 'dana@example.com', name: 'Dana', avatarColor: '#000', createdAt: 0 }

let stop: () => void
beforeEach(() => {
  localStorage.clear()
  useSession.setState({ status: 'ready', user: me, workspaces: [{ id: 'w1', name: 'Team', role: 'editor', personal: false, memberCount: 2 }], workspaceId: 'w1' } as never)
})
afterEach(() => {
  stop?.()
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function open(server: Project, version = 3) {
  vi.spyOn(api, 'project').mockResolvedValue({ project: server, version, summary })
  await loadInto('p1', false)
  stop = startAutosave()
}

describe('the local journal', { timeout: 20_000 }, () => {
  it('keeps edits the server doesn’t have yet, per person and project, and drops them once saved', async () => {
    vi.useFakeTimers()
    await open(doc('Launch'))
    const save = vi.spyOn(api, 'saveProject').mockRejectedValueOnce(new TypeError('Failed to fetch'))
    S().commit(updateProject(S().project, { background: '#ff0000' }), 'Background')
    await act(() => flush())
    await vi.advanceTimersByTimeAsync(JOURNAL_MS)
    const kept = readJournal('u1', 'p1')!
    expect(kept).toMatchObject({ baseVersion: 3, projectId: 'p1' })
    expect(kept.project.background).toBe('#ff0000')
    // nobody else's
    expect(readJournal('u2', 'p1')).toBeNull()
    save.mockResolvedValueOnce({ version: 4, updatedAt: 1 })
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(S().saveState).toBe('saved')
    await vi.advanceTimersByTimeAsync(JOURNAL_MS)
    expect(readJournal('u1', 'p1')).toBeNull()
  })

  it('is written at once when the tab closes', async () => {
    await open(doc('Launch'))
    vi.spyOn(api, 'saveProject').mockReturnValue(new Promise(() => undefined))
    S().commit(updateProject(S().project, { background: '#00ff00' }), 'Background')
    window.dispatchEvent(new Event('pagehide'))
    expect(readJournal('u1', 'p1')?.project.background).toBe('#00ff00')
  })

  it('offers kept changes back on open: Restore brings them back as one undoable edit', async () => {
    localStorage.setItem('ps.journal.u1.p1', JSON.stringify({ v: 1, projectId: 'p1', userId: 'u1', baseVersion: 3, savedAt: Date.now() - 60_000, project: doc('Launch', '#123456') }))
    await open(doc('Launch'))
    render(<MemoryRouter><JournalBanner /></MemoryRouter>)
    expect(screen.getByRole('alert').textContent).toMatch(/never reached the server/)
    const save = vi.spyOn(api, 'saveProject').mockResolvedValue({ version: 4, updatedAt: 1 })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Restore unsaved changes' })))
    expect(S().project.background).toBe('#123456')
    expect(S().history.past.at(-1)?.label).toBe('Restore unsaved changes')
    expect(screen.queryByRole('alert')).toBeNull()
    await act(() => flush())
    expect(save).toHaveBeenCalledWith('p1', expect.objectContaining({ background: '#123456' }), 3)
  })

  it('Discard forgets them', async () => {
    localStorage.setItem('ps.journal.u1.p1', JSON.stringify({ v: 1, projectId: 'p1', userId: 'u1', baseVersion: 3, savedAt: Date.now(), project: doc('Launch', '#123456') }))
    await open(doc('Launch'))
    render(<MemoryRouter><JournalBanner /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(readJournal('u1', 'p1')).toBeNull()
    expect(S().project.background).toBe('#000000')
  })

  it('kept changes made on an older version are merged onto what was saved since', async () => {
    const base = doc('Launch')
    localStorage.setItem('ps.journal.u1.p1', JSON.stringify({ v: 1, projectId: 'p1', userId: 'u1', baseVersion: 3, savedAt: Date.now(), project: { ...base, background: '#123456' } }))
    // a teammate renamed it meanwhile (version 5)
    await open({ ...base, name: 'Launch v2' }, 5)
    vi.spyOn(api, 'versionAt').mockResolvedValue({ project: base, summary: { id: 'pv1', version: 3, label: 'autosave', sizeBytes: 1, createdAt: 1 } })
    render(<MemoryRouter><JournalBanner /></MemoryRouter>)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Restore unsaved changes' })))
    expect(S().project).toMatchObject({ name: 'Launch v2', background: '#123456' })
    expect(S().saveState).toBe('dirty')
  })

  it('isn’t offered when the server already has the same changes', async () => {
    localStorage.setItem('ps.journal.u1.p1', JSON.stringify({ v: 1, projectId: 'p1', userId: 'u1', baseVersion: 3, savedAt: Date.now(), project: { ...doc('Launch', '#123456'), updatedAt: 99 } }))
    await open(doc('Launch', '#123456'), 4)
    expect(S().journalOffer).toBeUndefined()
    expect(readJournal('u1', 'p1')).toBeNull()
  })
})

describe('save states that say what is happening', { timeout: 20_000 }, () => {
  const edit = () => S().commit(updateProject(S().project, { background: '#abcdef' }), 'Background')

  it('Offline counts down to a retry that really happens, and Retry now doesn’t wait', async () => {
    vi.useFakeTimers()
    await open(doc('Launch'))
    const save = vi.spyOn(api, 'saveProject').mockRejectedValue(new TypeError('Failed to fetch'))
    render(<MemoryRouter><TopBar /></MemoryRouter>)
    edit()
    await act(() => flush())
    expect(screen.getByRole('button', { name: /Offline · retrying in 5 s/ })).toBeTruthy()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(screen.getByRole('button', { name: /retrying in 3 s/ })).toBeTruthy()
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(save).toHaveBeenCalledTimes(2)
    // backing off: the next wait is longer
    expect(screen.getByRole('button', { name: /retrying in 10 s/ })).toBeTruthy()
    save.mockResolvedValueOnce({ version: 4, updatedAt: 1 })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Offline/ })))
    await act(() => flush())
    expect(save).toHaveBeenCalledTimes(3)
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('a refusal says so and claims no retry', async () => {
    vi.useFakeTimers()
    await open(doc('Launch'))
    const save = vi.spyOn(api, 'saveProject').mockRejectedValue(new HttpError(400, { error: 'Invalid project: fps' }))
    render(<MemoryRouter><TopBar /></MemoryRouter>)
    edit()
    await act(() => flush())
    expect(screen.getByRole('button', { name: 'Failed · Retry' })).toBeTruthy()
    expect(screen.queryByText(/retrying/)).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a server failure is Failed with the retry it schedules', async () => {
    vi.useFakeTimers()
    await open(doc('Launch'))
    vi.spyOn(api, 'saveProject').mockRejectedValue(new HttpError(500, { error: 'Internal server error' }))
    render(<MemoryRouter><TopBar /><SaveErrorBanner /></MemoryRouter>)
    edit()
    await act(() => flush())
    expect(screen.getByRole('button', { name: /Failed · retrying in 5 s/ })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/tries again on its own/)
  })

  it('Too large says what is large', async () => {
    await open(doc('Launch'))
    let p = S().project
    for (let i = 0; i < 40; i++) p = addItem(p, createTextItem(i * 3, 'heading', { id: `t${i}`, duration: 2, text: 'A long title '.repeat(20) }))
    vi.spyOn(api, 'saveProject').mockRejectedValue(new HttpError(413, { error: 'Request body too large' }))
    render(<MemoryRouter><TopBar /><SaveErrorBanner /></MemoryRouter>)
    S().commit(p, 'Titles')
    await act(() => flush())
    expect(screen.getByText('Too large')).toBeTruthy()
    const msg = screen.getByRole('alert').textContent!
    expect(msg).toMatch(/too large to save \(\d+ KB\)/)
    expect(msg).toMatch(/The largest part is the text track “.+” \(40 items\)/)
  })

  it('Sign in again keeps the changes and saves them once signed back in', async () => {
    await open(doc('Launch'))
    const save = vi.spyOn(api, 'saveProject').mockRejectedValueOnce(new HttpError(401, { error: 'Sign in required' }))
    render(<MemoryRouter><TopBar /></MemoryRouter>)
    edit()
    await act(() => flush())
    expect(screen.getByRole('button', { name: 'Sign in again to save' })).toBeTruthy()
    // the session ends, then the same person signs in again (here or in another tab)
    save.mockResolvedValueOnce({ version: 4, updatedAt: 1 })
    act(() => useSession.setState({ status: 'anon', user: undefined } as never))
    await act(async () => {
      useSession.setState({ status: 'ready', user: me } as never)
      await flush()
    })
    expect(save).toHaveBeenCalledTimes(2)
    expect(S().saveState).toBe('saved')
  })
})
