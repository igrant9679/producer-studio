// The desktop's sync panel (D-1): opened from the sync menu, it says why sync is held up, shows each upload's bytes,
// previews a conflict side by side, and lists everything still to sync with Retry and Skip.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SyncConflictPreview, SyncItems, SyncStatus, SystemInfo } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncIndicator } from '../SystemChrome'
import { systemApi, useSystem } from '../system'

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({ linked: true, state: 'idle', pending: 3, conflicts: [], lastSyncAt: Date.now(), account: 'sam@example.com', cloudUrl: 'https://cloud.test', ...over })
const info: SystemInfo = { mode: 'desktop', version: '1', ai: { provider: 'claude-cli', available: true, detail: '' }, capabilities: { transcribe: true, tts: true, render: true } }
const items: SyncItems = {
  uploadBytes: 3 * 1024 ** 3,
  items: [
    { kind: 'asset', id: 'as_big', name: 'Drone pass.mov', workspaceId: 'w1', state: 'failed', bytes: 3 * 1024 ** 3, reason: 'File is larger than the 2048 MB upload limit' },
    { kind: 'project', id: 'p_new', name: 'Launch cut', workspaceId: 'w1', state: 'waiting' },
    { kind: 'project', id: 'p_gone', name: 'A project deleted here', workspaceId: '', state: 'failed', reason: 'The cloud refused the delete' },
  ],
}
const preview: SyncConflictPreview = {
  projectId: 'p_c',
  local: { version: 7, name: 'Cut for the client', updatedAt: Date.now() - 60_000, duration: 42, tracks: 3, items: 12, clips: 5, trashed: false },
  cloud: { version: 9, name: 'Cut for the web', updatedAt: Date.now() - 30_000, duration: 35, tracks: 3, items: 10, clips: 4, trashed: false },
  changes: ['Named “Cut for the client” here and “Cut for the web” in the cloud', '1 clip only in this computer’s copy'],
}

function open(s: SyncStatus) {
  useSystem.setState({ info: { ...info, sync: s }, sync: s, loaded: true })
  render(
    <MemoryRouter>
      <SyncIndicator />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Cloud sync/ }))
  fireEvent.click(screen.getByRole('button', { name: /Details/ }))
  return screen.getByRole('dialog', { name: 'Sync details' })
}

beforeEach(() => useSystem.setState({ info: undefined, sync: undefined }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the sync panel', () => {
  it('opens from the sync menu, says why sync is held up, and closes on Escape', async () => {
    vi.spyOn(systemApi, 'syncItems').mockResolvedValue({ items: [], uploadBytes: 0 })
    const dialog = open(status({ state: 'offline', blocked: { reason: 'offline', message: 'The cloud can’t be reached from here.' } }))
    expect(within(dialog).getByRole('status').textContent).toContain('The cloud can’t be reached from here.')
    await waitFor(() => expect(within(dialog).getByText('Everything on this computer is in the cloud.')).toBeTruthy())
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sync details' })).toBeNull())
  })

  it('shows each upload with its bytes and progress', async () => {
    vi.spyOn(systemApi, 'syncItems').mockResolvedValue({ items: [], uploadBytes: 0 })
    const dialog = open(status({ uploads: [{ id: 'as_1', name: 'Interview.mov', bytes: 200 * 1024 ** 2, sent: 50 * 1024 ** 2, startedAt: Date.now() }, { id: 'as_2', name: 'B-roll.mov', bytes: 80 * 1024 ** 2, sent: 0, startedAt: 0 }] }))
    const bar = within(dialog).getByRole('progressbar', { name: 'Uploading Interview.mov' })
    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(within(dialog).getByText(/50(\.0)? MB of 200(\.0)? MB/)).toBeTruthy()
    expect(within(dialog).getByText(/Waiting for a free lane/)).toBeTruthy()
  })

  it('lists what is still to sync, with reasons and sizes, and Retry / Skip for what failed', async () => {
    vi.spyOn(systemApi, 'syncItems').mockResolvedValue(items)
    const act = vi.spyOn(systemApi, 'syncFailure').mockResolvedValue(status())
    const dialog = open(status())
    await waitFor(() => expect(within(dialog).getByText('Drone pass.mov')).toBeTruthy())
    expect(within(dialog).getByText(/larger than the 2048 MB upload limit/)).toBeTruthy()
    expect(within(dialog).getByText(/3(\.0)? GB of clips to upload/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Retry Launch cut' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip Drone pass.mov' }))
    await waitFor(() => expect(act).toHaveBeenCalledWith({ kind: 'asset', id: 'as_big' }, 'skip'))
    // a delete that keeps failing is retried as a delete
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry A project deleted here' }))
    await waitFor(() => expect(act).toHaveBeenLastCalledWith({ kind: 'project-delete', id: 'p_gone' }, 'retry'))
  })

  it('compares the two copies of a conflict before choosing', async () => {
    vi.spyOn(systemApi, 'syncItems').mockResolvedValue({ items: [], uploadBytes: 0 })
    const get = vi.spyOn(systemApi, 'conflictPreview').mockResolvedValue(preview)
    const resolve = vi.spyOn(systemApi, 'resolve').mockResolvedValue(status({ conflicts: [] }))
    const dialog = open(status({ conflicts: [{ projectId: 'p_c', name: 'Launch cut', localVersion: 7, cloudVersion: 9 }] }))
    const compare = within(dialog).getByRole('button', { name: 'Compare' })
    expect(compare.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(compare)
    await waitFor(() => expect(get).toHaveBeenCalledWith('p_c'))
    const sides = await within(dialog).findByRole('group', { name: 'Launch cut: the two copies' })
    expect(within(sides).getByText('This computer')).toBeTruthy()
    expect(within(sides).getByText('Cut for the web')).toBeTruthy()
    expect(within(sides).getByText('1 clip only in this computer’s copy')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /Keep the cloud’s/ }))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('p_c', 'keep-cloud'))
  })
})
