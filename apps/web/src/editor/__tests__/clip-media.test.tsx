// Replace a clip's media from its menu or by Alt+dropping library media on it, and split at scene changes (E-10).
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, findItem, mainTrack, setKeyframe, type Asset, type Job, type Project, type VideoItem } from '@producer/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useToasts } from '../../lib/toast'
import { ReplaceMediaHost, useReplace } from '../clipMedia'
import { DRAG_MIME, endDrag, startDrag } from '../media'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'
import { useLibrary } from '../uploads'

const S = () => useEditor.getState()

const video = (id: string, duration = 10): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/demo/${id}.mp4`, duration, width: 1920, height: 1080, hasAudio: true })
const image: Asset = { id: 'img', kind: 'image', name: 'still.png', src: '/demo/still.png', width: 100, height: 100 }

beforeAll(() => {
  // jsdom has no DragEvent: one that carries the modifier keys and the drag's data
  globalThis.DragEvent ??= class extends MouseEvent {
    dataTransfer: DataTransfer | null = null
  } as unknown as typeof DragEvent
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})

function project(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, video('a'))
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va', duration: 8, in: 1 }))
  return setKeyframe(p, 'va', 'opacity', 2, 0.5)
}

beforeEach(() => {
  S().load({ project: project(), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  useLibrary.setState({ records: [video('b', 30), image].map((asset) => ({ asset, status: 'ready' }) as never) })
  useReplace.setState({ itemId: null })
  useToasts.setState({ toasts: [] })
})
afterEach(() => {
  cleanup()
  endDrag()
  vi.restoreAllMocks()
})

function show() {
  render(
    <>
      <Timeline />
      <ReplaceMediaHost />
    </>,
  )
  act(() => useEditor.setState({ zoom: 80 }))
}

const clipEl = (id: string) => document.querySelector(`.tl-clip[data-item="${id}"]`) as HTMLElement
const clip = (id = 'va') => findItem(S().project, id)?.item as VideoItem

/** The clip menu, opened from the keyboard (Shift+F10 on the focused clip). */
function openMenu() {
  const el = clipEl('va')
  act(() => el.focus())
  fireEvent.keyDown(el, { key: 'F10', shiftKey: true })
  return screen.getByRole('menu', { name: 'Clip' })
}

describe('replace clip (E-10)', () => {
  it('from the clip menu: choose media of the same kind, the clip keeps its timing and keyframes', () => {
    show()
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: /Replace media/ }))
    const dialog = screen.getByRole('dialog', { name: 'Replace video' })
    const list = within(dialog).getByRole('list', { name: 'Videos in the media library' })
    // only other videos: not the clip's own, not the picture
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['b.mp430s'])
    fireEvent.click(within(list).getByRole('button', { name: /b\.mp4/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(clip()).toMatchObject({ assetId: 'b', start: 0, duration: 8, in: 1, keyframes: { opacity: [{ t: 2, value: 0.5 }] } })
    expect(S().history.past.at(-1)?.label).toBe('Replace media')
    act(() => S().undo())
    expect(clip().assetId).toBe('a')
  })

  it('the dialog closes with Escape and says when there is nothing to choose', () => {
    useLibrary.setState({ records: [{ asset: image, status: 'ready' } as never] })
    show()
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: /Replace media/ }))
    const dialog = screen.getByRole('dialog', { name: 'Replace video' })
    expect(within(dialog).getByText(/No other videos in the media library/)).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Alt+drop of library media onto the clip replaces its media; a plain drop does not', () => {
    show()
    const dt = { types: [DRAG_MIME], dropEffect: 'none', effectAllowed: 'copy', setData() {}, getData: () => '' }
    startDrag({ dataTransfer: dt } as unknown as React.DragEvent, { kind: 'asset', asset: video('b', 30) })
    fireEvent.dragOver(clipEl('va'), { dataTransfer: dt })
    fireEvent.drop(clipEl('va'), { dataTransfer: dt })
    expect(clip().assetId).toBe('a')
    fireEvent.dragOver(clipEl('va'), { altKey: true, dataTransfer: dt })
    expect(clipEl('va').classList.contains('drop')).toBe(true)
    fireEvent.drop(clipEl('va'), { altKey: true, dataTransfer: dt })
    expect(clip()).toMatchObject({ assetId: 'b', duration: 8 })
    // a picture can't replace a video
    startDrag({ dataTransfer: dt } as unknown as React.DragEvent, { kind: 'asset', asset: image })
    fireEvent.drop(clipEl('va'), { altKey: true, dataTransfer: dt })
    expect(clip().assetId).toBe('b')
    expect(useToasts.getState().toasts.at(-1)?.text).toMatch(/same kind/)
  })
})

describe('split at scene changes (E-10)', () => {
  it('asks the server for the cuts in the clip’s part of the file and splits there', async () => {
    const detect = vi.spyOn(api, 'detectScenes').mockResolvedValue({ id: 'js', status: 'queued' } as never)
    vi.spyOn(api, 'job').mockResolvedValue({ id: 'js', kind: 'media.scenes', status: 'done', progress: 1, result: { assetId: 'a', cuts: [3, 6] } } as unknown as Job as never)
    show()
    const menu = openMenu()
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Split at scene changes' }))
      await new Promise((r) => setTimeout(r, 20))
    })
    // the clip shows 1..9 s of the file
    expect(detect).toHaveBeenCalledWith('a', { from: 1, to: 9 })
    expect(mainTrack(S().project)!.items.map((i) => [i.start, i.duration])).toEqual([
      [0, 2],
      [2, 3],
      [5, 3],
    ])
    expect(S().history.past.at(-1)?.label).toBe('Split at scene changes')
    expect(useToasts.getState().toasts.at(-1)?.text).toBe('Split at 2 scene changes')
  })

  it('says so when there are none', async () => {
    vi.spyOn(api, 'detectScenes').mockResolvedValue({ id: 'js', status: 'queued' } as never)
    vi.spyOn(api, 'job').mockResolvedValue({ id: 'js', status: 'done', progress: 1, result: { assetId: 'a', cuts: [] } } as never)
    show()
    const menu = openMenu()
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Split at scene changes' }))
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(mainTrack(S().project)!.items).toHaveLength(1)
    expect(useToasts.getState().toasts.at(-1)?.text).toBe('No scene changes found in this clip')
  })
})
