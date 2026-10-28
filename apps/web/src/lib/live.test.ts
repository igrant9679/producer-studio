// P-16 in the client: the live-update stream keeps its place, reopens after the server closes it, and asks the
// screen to reload when what was missed can't be replayed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, LIVE_RETRY_MS, api, setUnauthorizedHandler, subscribeEvents } from './api'

/** Stands in for the browser's EventSource: the test plays the server. */
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
    this.readyState = 2
  }
  emit(name: string, data: unknown, id?: string) {
    for (const fn of this.listeners.get(name) ?? []) fn(new MessageEvent(name, { data: JSON.stringify(data), lastEventId: id ?? '' }))
  }
  /** The server refused or went away for good (not the browser's own retry). */
  fail() {
    this.readyState = 2
    this.onerror?.()
  }
}
const last = () => FakeEventSource.all[FakeEventSource.all.length - 1]

beforeEach(() => {
  FakeEventSource.all = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setUnauthorizedHandler(undefined)
})

describe('the live-update stream', () => {
  it('reopens where it left off after the server closes it', async () => {
    vi.spyOn(api, 'me').mockResolvedValue({} as never)
    const projects: number[] = []
    const off = subscribeEvents('w1', { project: (p) => projects.push(p.version) })
    expect(last().url).toBe('/api/events?workspaceId=w1')
    last().emit('ready', {}, 'w_a.10')
    last().emit('project', { id: 'p1', version: 2 }, 'w_a.11')
    // the browser retrying by itself (still connecting) is left alone
    last().readyState = 0
    last().onerror?.()
    expect(FakeEventSource.all).toHaveLength(1)
    last().fail()
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_MS)
    expect(FakeEventSource.all).toHaveLength(2)
    expect(last().url).toBe('/api/events?workspaceId=w1&lastEventId=w_a.11')
    last().emit('project', { id: 'p1', version: 3 }, 'w_a.12')
    expect(projects).toEqual([2, 3])
    off()
    expect(last().closed).toBe(true)
  })

  it('asks the screen to reload when the server says resync', () => {
    const resync = vi.fn()
    subscribeEvents('w1', { resync })
    last().emit('resync', {}, 'w_b.3')
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('a refusal because the session ended signs the tab out', async () => {
    vi.spyOn(api, 'me').mockRejectedValue(new HttpError(401, { error: 'Sign in required' }))
    const signedOut = vi.fn()
    setUnauthorizedHandler(signedOut)
    subscribeEvents('w1', {})
    last().fail()
    await vi.advanceTimersByTimeAsync(0)
    expect(signedOut).toHaveBeenCalled()
  })

  it('passes other named events to `on` handlers (presence and the like)', () => {
    const presence = vi.fn()
    subscribeEvents('w1', { on: { presence } })
    last().emit('presence', { users: ['u1'] }, 'w_c.1')
    expect(presence).toHaveBeenCalledWith({ users: ['u1'] })
  })

  it('stops reopening once unsubscribed', async () => {
    vi.spyOn(api, 'me').mockResolvedValue({} as never)
    const off = subscribeEvents('w1', {})
    last().fail()
    off()
    await vi.advanceTimersByTimeAsync(LIVE_RETRY_MS * 4)
    expect(FakeEventSource.all).toHaveLength(1)
  })
})
