// Files dropped from the desktop onto the timeline (E-9) upload and land where they were dropped (that track, that
// time), each once the server has processed it, one after the other.
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { addAsset, addItem, createAudioItem, createProject, createVideoItem, type Asset, type AssetRecord, type Project } from '@producer/core'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'
import { HEADER_W } from '../timelineMath'
import { useLibrary } from '../uploads'

const S = () => useEditor.getState()

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
  // jsdom has no DragEvent: a mouse event carries the drop position
  globalThis.DragEvent ??= class extends MouseEvent {} as unknown as typeof DragEvent
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function project(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, { id: 'a', kind: 'video', name: 'a.mp4', src: '/api/media/a/source', duration: 10, width: 1920, height: 1080, hasAudio: true })
  p = addAsset(p, { id: 'm', kind: 'audio', name: 'm.mp3', src: '/api/media/m/source', duration: 30 })
  p = addItem(p, createVideoItem(p.assets.a, 0))
  return addItem(p, createAudioItem(p.assets.m, 0, { id: 'bed', duration: 2 }))
}

const sound = (id: string, duration: number): Asset => ({ id, kind: 'audio', name: `${id}.mp3`, src: `/api/media/${id}/source`, duration })
const rec = (asset: Asset, status: AssetRecord['status']) => ({ asset, status }) as AssetRecord

describe('dropping files on the timeline (E-9)', () => {
  it('uploads them and puts each on the track and at the time it was dropped, as it becomes ready', async () => {
    S().load({ project: project(), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
    useLibrary.setState({ records: [], uploads: [] })
    const ready = sound('as_one', 3)
    const later = sound('as_two', 2)
    vi.spyOn(api, 'upload').mockImplementation(async (_ws, file) => (file.name === 'one.mp3' ? rec(ready, 'ready') : rec({ ...later, duration: undefined }, 'processing')))
    vi.spyOn(api, 'asset').mockImplementation(async () => rec({ ...later, duration: undefined }, 'processing'))
    render(<Timeline />)
    act(() => useEditor.setState({ zoom: 80 }))
    const rows = document.querySelector('.tl-rows')!
    const files = [new File(['x'], 'one.mp3', { type: 'audio/mpeg' }), new File(['y'], 'two.mp3', { type: 'audio/mpeg' })]
    // the audio row sits under the main track: y 84..130; 4 s in at 80 px/s
    const at = { clientX: HEADER_W + 4 * 80, clientY: 100 }
    fireEvent.dragOver(rows, { ...at, dataTransfer: { types: ['Files'], files, dropEffect: 'none' } })
    expect(document.querySelector('.tl-ghost.drop')).not.toBeNull()
    fireEvent.drop(rows, { ...at, dataTransfer: { types: ['Files'], files } })
    const audioTrack = () => S().project.tracks.find((t) => t.kind === 'audio')!
    await waitFor(() => expect(audioTrack().items).toHaveLength(2))
    expect(audioTrack().items[1]).toMatchObject({ assetId: 'as_one', start: 4, duration: 3 })
    expect(api.upload).toHaveBeenCalledTimes(2)
    // the second file is still processing; once it's ready it goes right after the first
    act(() => useLibrary.setState({ records: useLibrary.getState().records.map((r) => (r.asset.id === 'as_two' ? rec(later, 'ready') : r)) }))
    await waitFor(() => expect(audioTrack().items).toHaveLength(3))
    expect(audioTrack().items[2]).toMatchObject({ assetId: 'as_two', start: 7, duration: 2 })
    expect(S().history.past.map((h) => h.label).filter((l) => l.startsWith('Add'))).toEqual(['Add audio', 'Add audio'])
  })

  it('a file that fails processing is left in the library and nothing is placed', async () => {
    S().load({ project: project(), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
    useLibrary.setState({ records: [], uploads: [] })
    vi.spyOn(api, 'upload').mockImplementation(async () => rec(sound('as_bad', 1), 'processing'))
    vi.spyOn(api, 'asset').mockImplementation(async () => rec(sound('as_bad', 1), 'processing'))
    render(<Timeline />)
    const before = S().project
    fireEvent.drop(document.querySelector('.tl-rows')!, { clientX: HEADER_W + 80, clientY: 100, dataTransfer: { types: ['Files'], files: [new File(['z'], 'bad.mp3', { type: 'audio/mpeg' })] } })
    await waitFor(() => expect(useLibrary.getState().records.some((r) => r.asset.id === 'as_bad')).toBe(true))
    act(() => useLibrary.setState({ records: [{ ...rec(sound('as_bad', 1), 'error'), error: 'bad file' }] }))
    await new Promise((r) => setTimeout(r, 20))
    expect(S().project.tracks).toEqual(before.tracks)
  })
})
