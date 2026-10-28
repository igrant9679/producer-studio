// Freeze frames (E-24): the toolbar's Freeze button sets how long the hold is and freezes at the playhead or at the
// end of the clip; a freeze frame's hold is changed in the properties panel.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, mainTrack, type Asset, type Project, type VideoItem } from '@producer/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { freezeEnd } from '../actions'
import { FreezeHold } from '../FreezeMenu'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'

const S = () => useEditor.getState()
const video = (id: string, duration = 10): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration, width: 1920, height: 1080, hasAudio: true })

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})
afterEach(cleanup)

function twoClips(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, video('a'))
  p = addAsset(p, video('b'))
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
  return addItem(p, createVideoItem(p.assets.b, 10, { id: 'vb' }))
}

const main = () => mainTrack(S().project)!.items.map((i) => [i.start, i.duration, (i as VideoItem).freezeAt !== undefined])

function openFreeze() {
  fireEvent.click(screen.getByRole('button', { name: 'Freeze frame' }))
  return screen.getByRole('dialog', { name: 'Freeze frame' })
}

describe('freeze frames (E-24)', () => {
  it('the Freeze button opens the hold length; a 3.5 s hold at the playhead', () => {
    S().load({ project: twoClips(), version: 1, projectId: 'p1', demo: true })
    render(<Timeline />)
    act(() => S().setPlayhead(4))
    const box = openFreeze()
    expect(screen.getByRole('button', { name: 'Freeze frame' }).getAttribute('aria-expanded')).toBe('true')
    const hold = within(box).getByRole('textbox')
    fireEvent.focus(hold)
    fireEvent.change(hold, { target: { value: '3.5' } })
    fireEvent.blur(hold)
    expect(S().freezeSec).toBe(3.5)
    fireEvent.click(within(box).getByRole('button', { name: /At the playhead/ }))
    expect(main()).toEqual([
      [0, 4, false],
      [4, 3.5, true],
      [7.5, 6, false],
      [13.5, 10, false],
    ])
    expect(screen.queryByRole('dialog', { name: 'Freeze frame' })).toBeNull()
  })

  it('freeze at the end of the selected clip holds its last frame after it, and Escape closes the box', () => {
    S().load({ project: twoClips(), version: 1, projectId: 'p1', demo: true })
    useEditor.setState({ freezeSec: 2 })
    render(<Timeline />)
    act(() => S().select(['va']))
    fireEvent.keyDown(openFreeze(), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Freeze frame' })).toBeNull()
    fireEvent.click(within(openFreeze()).getByRole('button', { name: /At the end of the clip/ }))
    expect(main()).toEqual([
      [0, 10, false],
      [10, 2, true],
      [12, 10, false],
    ])
    expect(S().history.past.at(-1)!.label).toBe('Freeze last frame')
    // the clip menu has it too
    fireEvent.contextMenu(document.querySelector('.tl-clip[data-item="vb"]')!, { clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Freeze last frame' }))
    expect(main().at(-1)).toEqual([22, 2, true])
  })

  it('a freeze frame’s hold is changed in the properties panel', () => {
    S().load({ project: twoClips(), version: 1, projectId: 'p1', demo: true })
    act(() => S().select(['va']))
    useEditor.setState({ freezeSec: 2 })
    act(() => freezeEnd('va'))
    const hold = mainTrack(S().project)!.items[1] as VideoItem
    const { rerender } = render(<FreezeHold item={hold} />)
    const input = screen.getByRole('textbox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.blur(input)
    rerender(<FreezeHold item={mainTrack(S().project)!.items[1] as VideoItem} />)
    expect(main()).toEqual([
      [0, 10, false],
      [10, 5, true],
      [15, 10, false],
    ])
  })
})
