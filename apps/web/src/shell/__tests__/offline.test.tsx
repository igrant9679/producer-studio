// "Available offline" in the library (D-9): a linked desktop offers the menu item, badges projects kept offline (and
// still downloading), and badges clips that are only in the cloud. A cloud browser, or an unlinked desktop, shows none.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { OfflineInfo, SyncStatus, SystemInfo } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudOnlyBadge, OfflineBadge, offlineMenuItem, useOffline, type OfflineState } from '../sync/offline'
import { systemApi, useSystem } from '../system'

const desktop: SystemInfo = { mode: 'desktop', version: '1', ai: { provider: 'claude-cli', available: true, detail: '' }, capabilities: { transcribe: true, tts: true, render: true } }
const linked: SyncStatus = { linked: true, state: 'idle', pending: 0, conflicts: [], lastSyncAt: 1 }
const info: OfflineInfo = { projects: { p1: { pinned: true, missing: 2, missingBytes: 300 * 1024 ** 2 }, p2: { pinned: true, missing: 0, missingBytes: 0 } }, cloudOnly: ['a_cloud'] }

let state: OfflineState | undefined
function Library() {
  const o = useOffline('w1')
  state = o
  return (
    <div>
      {['p1', 'p2', 'p3'].map((id) => (
        <div key={id} data-testid={id}>
          <OfflineBadge o={o} projectId={id} />
        </div>
      ))}
      {['a_cloud', 'a_here'].map((id) => (
        <div key={id} data-testid={id}>
          <CloudOnlyBadge o={o} assetId={id} />
        </div>
      ))}
    </div>
  )
}

beforeEach(() => {
  state = undefined
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('available offline in the library', () => {
  it('badges projects kept offline, still downloading or ready, and clips only in the cloud', async () => {
    useSystem.setState({ info: desktop, sync: linked, loaded: true })
    const get = vi.spyOn(systemApi, 'offline').mockResolvedValue(info)
    render(<Library />)
    await waitFor(() => expect(get).toHaveBeenCalledWith('w1'))
    expect(await screen.findByRole('img', { name: 'Downloading for offline use: 2 clips left (300 MB)' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Available offline' })).toBeTruthy()
    expect(screen.getByTestId('p3').textContent).toBe('')
    expect(screen.getByRole('img', { name: 'Only in the cloud: it downloads when you open it' }).closest('[data-testid]')?.getAttribute('data-testid')).toBe('a_cloud')
    expect(screen.getByTestId('a_here').children).toHaveLength(0)
  })

  it('the project menu keeps a project offline, or stops', async () => {
    useSystem.setState({ info: desktop, sync: linked, loaded: true })
    vi.spyOn(systemApi, 'offline').mockResolvedValue(info)
    const set = vi.spyOn(systemApi, 'setOffline').mockResolvedValue({ projects: {}, cloudOnly: [] })
    render(<Library />)
    await waitFor(() => expect(state?.info).toBeTruthy())
    const [keep] = offlineMenuItem(state!, { id: 'p3', name: 'Launch' })
    expect(keep.label).toBe('Keep available offline')
    await act(async () => keep.onClick!())
    expect(set).toHaveBeenCalledWith('p3', true)
    // after that answer nothing is pinned any more
    expect(offlineMenuItem(state!, { id: 'p1', name: 'Cut' })[0].label).toBe('Keep available offline')
  })

  it('offers nothing in the cloud app or on an unlinked desktop', async () => {
    const get = vi.spyOn(systemApi, 'offline').mockResolvedValue(info)
    useSystem.setState({ info: { ...desktop, mode: 'cloud' }, sync: undefined, loaded: true })
    render(<Library />)
    expect(offlineMenuItem(state!, { id: 'p1', name: 'Cut' })).toEqual([])
    cleanup()
    useSystem.setState({ info: desktop, sync: { ...linked, linked: false, state: 'unlinked' }, loaded: true })
    render(<Library />)
    expect(offlineMenuItem(state!, { id: 'p1', name: 'Cut' })).toEqual([])
    expect(get).not.toHaveBeenCalled()
    expect(screen.queryByRole('img')).toBeNull()
  })
})
