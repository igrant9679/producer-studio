// Lists page by cursor and clip records in lists and live updates are light (no transcript): the editor still gets
// every transcript it uses, from the full record, when a clip is put into the project or a new transcript is announced.
// (SEC-18)
import { createProject, transcriptRev, type Asset, type AssetRecord, type Transcript } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { addAssetAt } from '../actions'
import { useEditor } from '../store'
import { loadLibrary, subscribeWorkspace, useLibrary } from '../uploads'

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

const transcript = (text: string): Transcript => ({ language: 'en', engine: 'whisper', segments: [{ start: 0, end: 1, text, words: text.split(' ').map((w, i) => ({ w, start: i * 0.3, end: i * 0.3 + 0.2 })) }] })
const clip = (id: string, extra: Partial<Asset> = {}): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration: 4, width: 1280, height: 720, hasAudio: true, createdAt: 1, ...extra })
const light = (a: Asset, tr?: Transcript): AssetRecord => ({ asset: a, workspaceId: 'w1', status: 'ready', origin: 'upload', createdAt: 1, light: true, ...(tr ? { transcriptRev: transcriptRev(tr) } : {}) })
const full = (a: Asset, tr: Transcript): AssetRecord => ({ asset: { ...a, transcript: tr }, workspaceId: 'w1', status: 'ready', origin: 'upload', createdAt: 1 })
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource)
  useLibrary.setState({ records: [], loaded: false })
  useEditor.getState().load({ project: createProject({ id: 'p1', name: 'Light' }), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('paged lists', () => {
  it('follow nextCursor to the end, so a long library never stops at the first page', async () => {
    const pages: Record<string, { items: AssetRecord[]; nextCursor?: string }> = {
      '': { items: [light(clip('a1')), light(clip('a2'))], nextCursor: 'c1' },
      c1: { items: [light(clip('a3'))], nextCursor: 'c2' },
      c2: { items: [light(clip('a4'))] },
    }
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        const cursor = new URL(url, 'http://x').searchParams.get('cursor') ?? ''
        return new Response(JSON.stringify(pages[cursor]), { status: 200, headers: { 'content-type': 'application/json' } })
      }),
    )
    await loadLibrary('w1')
    expect(useLibrary.getState().records.map((r) => r.asset.id)).toEqual(['a1', 'a2', 'a3', 'a4'])
    expect(urls).toHaveLength(3)
    expect(urls[1]).toContain('cursor=c1')
  })
})

describe('light clip records in the editor', () => {
  it('a clip put into the project from the library gets its transcript from the full record', async () => {
    const tr = transcript('hello there friend')
    const a = clip('as1')
    useLibrary.setState({ records: [light(a, tr)], loaded: true })
    const get = vi.spyOn(api, 'asset').mockResolvedValue(full(a, tr))
    addAssetAt(a, 0)
    await settle()
    await settle()
    expect(get).toHaveBeenCalledWith('as1')
    expect(useEditor.getState().project.assets.as1.transcript).toEqual(tr)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('a live update naming a new transcript fetches it once; the same one again fetches nothing and keeps it', async () => {
    const a = clip('as2')
    useEditor.getState().load({ project: { ...createProject({ id: 'p2', name: 'Live' }), assets: { as2: a } }, version: 1, projectId: 'p2', demo: false, workspaceId: 'w1' })
    const tr = transcript('one two three')
    const get = vi.spyOn(api, 'asset').mockResolvedValue(full(a, tr))
    const stop = subscribeWorkspace('w1', () => undefined)
    FakeEventSource.last.emit('asset', light(a, tr))
    await settle()
    await settle()
    expect(useEditor.getState().project.assets.as2.transcript).toEqual(tr)
    // the same transcript announced again (a rename): no fetch, and the light record doesn't wipe it
    FakeEventSource.last.emit('asset', light({ ...a, name: 'renamed.mp4' }, tr))
    await settle()
    expect(get).toHaveBeenCalledTimes(1)
    expect(useEditor.getState().project.assets.as2).toMatchObject({ name: 'renamed.mp4', transcript: tr })
    // a clip this editor doesn't use is left alone
    FakeEventSource.last.emit('asset', light(clip('elsewhere'), tr))
    await settle()
    expect(get).toHaveBeenCalledTimes(1)
    stop()
  })
})
