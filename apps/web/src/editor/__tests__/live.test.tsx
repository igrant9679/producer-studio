// Live updates reaching the editor: a brand kit saved elsewhere reloads in the Brand panel.
import { act, cleanup, render, screen } from '@testing-library/react'
import { createProject, type BrandKitDoc } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { BrandPanel } from '../panels/BrandPanel'
import { useEditor } from '../store'
import { subscribeWorkspace } from '../uploads'

/** Stands in for the browser's EventSource: the test sends the server's events by hand. */
class FakeEventSource {
  static last: FakeEventSource
  listeners = new Map<string, (e: MessageEvent) => void>()
  constructor(public url: string) {
    FakeEventSource.last = this
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(name, fn)
  }
  close() {}
  emit(name: string, data: unknown) {
    this.listeners.get(name)?.(new MessageEvent(name, { data: JSON.stringify(data) }))
  }
}

const kit = (name: string): BrandKitDoc => ({ name, colors: ['#112233'], fonts: { headline: 'Inter', body: 'Inter' } })

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource)
  useEditor.getState().load({ project: createProject({ id: 'p1', name: 'Live' }), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('live updates in the editor', { timeout: 20_000 }, () => {
  it('reloads the brand kit when someone saves it', async () => {
    const brand = vi.spyOn(api, 'brand').mockResolvedValueOnce(kit('Before')).mockResolvedValueOnce(kit('After'))
    const stop = subscribeWorkspace('w1', () => undefined)
    render(<BrandPanel />)
    expect(await screen.findByText('Before')).toBeTruthy()
    await act(async () => FakeEventSource.last.emit('workspace', { id: 'w1', deleted: false, brand: true }))
    expect(await screen.findByText('After')).toBeTruthy()
    expect(brand).toHaveBeenCalledTimes(2)
    stop()
  })
})
