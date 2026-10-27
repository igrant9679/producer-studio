import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SyncFailure, SyncStatus, SystemInfo } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncIndicator, syncSummary } from '../SystemChrome'
import { systemApi, useSystem } from '../system'

const failure = (over: Partial<SyncFailure> = {}): SyncFailure => ({
  kind: 'asset',
  id: 'as_big',
  name: 'Interview.mov',
  error: 'File is larger than the 4096 MB upload limit',
  attempts: 3,
  skipped: false,
  at: Date.now(),
  ...over,
})
const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({ linked: true, state: 'idle', pending: 1, conflicts: [], lastSyncAt: Date.now(), account: 'sam@example.com', cloudUrl: 'https://cloud.test', ...over })
const info: SystemInfo = { mode: 'desktop', version: '1', ai: { provider: 'claude-cli', available: true, detail: '' }, capabilities: { transcribe: true, tts: true, render: true } }

function show(s: SyncStatus) {
  useSystem.setState({ info: { ...info, sync: s }, sync: s, loaded: true })
  render(
    <MemoryRouter>
      <SyncIndicator />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Cloud sync/ }))
}

beforeEach(() => useSystem.setState({ info: undefined, sync: undefined }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('what sync kept safe', () => {
  it('shows each notice until dismissed', async () => {
    const message = '“Shared cut” was deleted here, but edited in the cloud since. The cloud version was kept and is back in your projects; delete it again if you still want it gone.'
    const dismiss = vi.spyOn(systemApi, 'syncNotice').mockResolvedValueOnce(status({ notices: [] }))
    show(status({ notices: [{ id: 'n_1', message, at: Date.now() }] }))
    expect(screen.getByText('Kept safe')).toBeTruthy()
    expect(screen.getByText(message)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Got it/ }))
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('n_1', 'dismiss'))
    await waitFor(() => expect(screen.queryByText(message)).toBeNull())
  })
})

describe('items that keep failing to sync', () => {
  it('are counted in the summary until skipped', () => {
    expect(syncSummary(status({ failures: [failure()] }))).toEqual({ label: '1 not synced', tone: 'warn' })
    expect(syncSummary(status({ failures: [failure({ skipped: true })] })).label).toBe('1 pending')
    expect(syncSummary(status({ failures: [failure()], conflicts: [{ projectId: 'p', name: 'P', localVersion: 1, cloudVersion: 2 }] })).label).toBe('1 conflict')
  })

  it('lists each one with its reason and offers Retry and Skip', async () => {
    const retry = vi.spyOn(systemApi, 'syncFailure').mockResolvedValueOnce(status({ failures: [failure({ attempts: 4 })] }))
    show(status({ failures: [failure()] }))
    expect(screen.getByText('Couldn’t sync')).toBeTruthy()
    expect(screen.getByText('Interview.mov')).toBeTruthy()
    expect(screen.getByText(/larger than the 4096 MB upload limit/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(retry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'asset', id: 'as_big' }), 'retry'))

    retry.mockResolvedValueOnce(status({ pending: 0, failures: [failure({ skipped: true })] }))
    fireEvent.click(screen.getByRole('button', { name: /Skip/ }))
    await waitFor(() => expect(retry).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'as_big' }), 'skip'))
    // a skipped item says so and can still be retried, but not skipped again
    await waitFor(() => expect(screen.getByText(/Skipped — stays on this computer only/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()
  })
})
