// Desktop sync status in the shell (R4-C): it follows the resumable live-update stream (carried from R2: no stream of
// its own), reloads when that stream can't replay what it missed, and starts a sync as soon as the connection comes
// back while sync waits offline (D-8).
import { cleanup, render, waitFor } from '@testing-library/react'
import type { SyncStatus, SystemInfo } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { systemApi, useSyncPolling, useSystem } from '../system'

class FakeEventSource {
  static all: FakeEventSource[] = []
  listeners = new Map<string, Array<(e: MessageEvent) => void>>()
  readyState = 1
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.all.push(this)
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn])
  }
  close() {
    this.closed = true
  }
  emit(name: string, data: unknown, id = '') {
    for (const fn of this.listeners.get(name) ?? []) fn(new MessageEvent(name, { data: JSON.stringify(data), lastEventId: id }))
  }
}

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({ linked: true, state: 'idle', pending: 0, conflicts: [], ...over })
const info: SystemInfo = { mode: 'desktop', version: '1', ai: { provider: 'claude-cli', available: true, detail: '' }, capabilities: { transcribe: true, tts: true, render: true } }

function Probe({ ws }: { ws: string }) {
  useSyncPolling(ws)
  return null
}

beforeEach(() => {
  FakeEventSource.all = []
  vi.stubGlobal('EventSource', FakeEventSource)
  useSystem.setState({ info, sync: status(), loaded: true })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('desktop sync status in the shell', () => {
  it('follows the resumable live-update stream, and reloads when it says it missed events', async () => {
    const poll = vi.spyOn(systemApi, 'syncStatus').mockResolvedValue(status())
    const { unmount } = render(<Probe ws="w1" />)
    await waitFor(() => expect(poll).toHaveBeenCalledTimes(1))
    expect(FakeEventSource.all).toHaveLength(1)
    const es = FakeEventSource.all[0]
    expect(es.url).toBe('/api/events?workspaceId=w1')
    es.emit('sync', status({ state: 'syncing', pending: 2 }), 'p.1')
    expect(useSystem.getState().sync?.pending).toBe(2)
    // missed events it can't replay: the status is fetched again
    es.emit('resync', {}, 'p.2')
    await waitFor(() => expect(poll).toHaveBeenCalledTimes(2))
    unmount()
    expect(es.closed).toBe(true)
  })

  it('starts a sync when the connection comes back while sync waits offline, and only then', async () => {
    vi.spyOn(systemApi, 'syncStatus').mockResolvedValue(status({ state: 'offline' }))
    const online = vi.spyOn(systemApi, 'syncOnline').mockResolvedValue(status({ state: 'syncing' }))
    render(<Probe ws="w1" />)
    await waitFor(() => expect(useSystem.getState().sync?.state).toBe('offline'))
    window.dispatchEvent(new Event('online'))
    await waitFor(() => expect(online).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useSystem.getState().sync?.state).toBe('syncing'))
    // already syncing: nothing more to ask
    window.dispatchEvent(new Event('online'))
    expect(online).toHaveBeenCalledTimes(1)
  })
})
