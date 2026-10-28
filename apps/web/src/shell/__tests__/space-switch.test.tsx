// APP-15: after a space switch nothing from the old space shows (or can be clicked) under the new name, even while
// the new load is out or when it fails. APP-33: uploads belong to the space they went to.
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { AiSettings, AssetRecord, Voice, Workspace } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { CORE_VOICES, useVoices } from '../components/VoiceCard'
import { AiProviders } from '../pages/AiProviders'
import { uploadFiles, uploadsIn, useUploads } from '../stores'
import { systemApi } from '../system'
import { useAsync } from '../ui'

const a: Workspace = { id: 'ws_a', name: 'Alpha', role: 'owner', personal: true, memberCount: 1 }
const b: Workspace = { id: 'ws_b', name: 'Bravo', role: 'owner', personal: false, memberCount: 2 }
const switchTo = (ws: Workspace) => act(() => useSession.setState({ workspaceId: ws.id }))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  localStorage.clear()
  useSession.setState({ status: 'ready', workspaces: [a, b], workspaceId: a.id })
  useUploads.setState({ items: [] })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useAsync after a space switch', () => {
  it('shows nothing from the old space while the new one loads, then the new one', async () => {
    const loads: Record<string, ReturnType<typeof deferred<string[]>>> = { ws_a: deferred(), ws_b: deferred() }
    const { result } = renderHook(() => {
      const ws = useSession((s) => s.workspaceId)!
      return useAsync(() => loads[ws].promise, [ws])
    })
    await act(async () => loads.ws_a.resolve(['alpha project']))
    expect(result.current.data).toEqual(['alpha project'])
    switchTo(b)
    expect(result.current.data).toBeUndefined()
    expect(result.current.loading).toBe(true)
    await act(async () => loads.ws_b.resolve(['bravo project']))
    expect(result.current.data).toEqual(['bravo project'])
  })

  it('never falls back to the old space’s items when the new load fails', async () => {
    const { result } = renderHook(() => {
      const ws = useSession((s) => s.workspaceId)!
      return useAsync(() => (ws === a.id ? Promise.resolve(['alpha project']) : Promise.reject(new Error('offline'))), [ws])
    })
    await waitFor(() => expect(result.current.data).toEqual(['alpha project']))
    switchTo(b)
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.data).toBeUndefined()
  })

  it('keeps showing what it has while reloading the same space', async () => {
    let n = 0
    const { result } = renderHook(() => useAsync(() => Promise.resolve(++n), []))
    await waitFor(() => expect(result.current.data).toBe(1))
    act(() => result.current.reload())
    expect(result.current.data).toBe(1)
    await waitFor(() => expect(result.current.data).toBe(2))
  })
})

describe('voices after a space switch', () => {
  it('drop the old space’s cloned voices, even when the new space’s list can’t load', async () => {
    const mine: Voice = { ...CORE_VOICES[0], id: 'clone_a', name: 'Alpha boss', source: 'clone', available: true }
    vi.spyOn(api, 'voices').mockImplementation(async (ws) => (ws === a.id ? [mine, ...CORE_VOICES] : Promise.reject(new Error('offline'))))
    const { result } = renderHook(() => useVoices())
    await waitFor(() => expect(result.current[0].id).toBe('clone_a'))
    switchTo(b)
    expect(result.current.some((v) => v.id === 'clone_a')).toBe(false)
    await act(async () => undefined)
    expect(result.current.some((v) => v.id === 'clone_a')).toBe(false)
  })
})

describe('AI settings after a space switch', () => {
  it('don’t show the old space’s keys when the new space’s settings fail to load', async () => {
    const eff = { provider: 'openai' as const, model: 'gpt-alpha' }
    const settings: AiSettings = {
      canEdit: true,
      defaultProvider: 'openai',
      perFeature: {},
      builtin: { id: 'anthropic-api', available: false, detail: '' },
      providers: { openai: { model: 'gpt-alpha', hasKey: true, keyLast4: 'AAAA', models: ['gpt-alpha'] } },
      effective: { writer: eff, script: eff, assistant: eff },
    }
    vi.spyOn(systemApi, 'aiSettings').mockImplementation(async (ws) => (ws === a.id ? settings : Promise.reject(new Error('offline'))))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(screen.getAllByText(/OpenAI/).length).toBeGreaterThan(0))
    expect(screen.queryByText(/Couldn’t load AI settings/)).toBeNull()
    switchTo(b)
    expect(await screen.findByText(/Couldn’t load AI settings: offline/)).toBeTruthy()
    expect(document.querySelectorAll('.ps-ai-card').length).toBe(1) // only the built-in card, no key cards
  })
})

describe('uploads', () => {
  it('are kept with their space, and finish even after a switch closes that space’s live stream', async () => {
    const processing = { asset: { id: 'as_1', name: 'clip.mp4', kind: 'video' }, workspaceId: a.id, status: 'processing' } as unknown as AssetRecord
    vi.spyOn(api, 'upload').mockResolvedValue(processing)
    const poll = vi.spyOn(api, 'asset').mockResolvedValueOnce(processing).mockResolvedValue({ ...processing, status: 'ready' } as AssetRecord)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await uploadFiles(a.id, [new File(['x'], 'clip.mp4', { type: 'video/mp4' })])
      const items = useUploads.getState().items
      expect(uploadsIn(items, a.id).map((u) => u.name)).toEqual(['clip.mp4'])
      expect(uploadsIn(items, b.id)).toEqual([])
      switchTo(b)
      await vi.advanceTimersByTimeAsync(6000)
      await waitFor(() => expect(useUploads.getState().items[0].status).toBe('ready'))
      expect(poll).toHaveBeenCalledWith('as_1')
    } finally {
      vi.useRealTimers()
    }
  })
})
