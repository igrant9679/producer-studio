// Keyboard shortcuts shown in tooltips (E-26): buttons with a key carry it in their tooltip (and their accessible
// name), and menus list it beside the command.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, type Project } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Canvas } from '../Canvas'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'
import { TopBar } from '../TopBar'

const S = () => useEditor.getState()

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})
afterEach(cleanup)

function project(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, { id: 'a', kind: 'video', name: 'a.mp4', src: '/api/media/a/source', duration: 10, width: 1920, height: 1080, hasAudio: true })
  return addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
}

const kbdOf = (name: string | RegExp) => screen.getByRole('button', { name }).getAttribute('data-tip-kbd')

describe('shortcuts in tooltips (E-26)', () => {
  it('the timeline toolbar names each button’s key', () => {
    S().load({ project: project(), version: 1, projectId: 'p1', demo: true })
    S().select(['va'])
    render(<Timeline />)
    expect(kbdOf(/^Split/)).toBe('Ctrl+B')
    expect(kbdOf(/^Delete/)).toBe('Del')
    expect(kbdOf(/^Duplicate/)).toBe('Ctrl+D')
    expect(kbdOf('Separate audio (Ctrl+Shift+S)')).toBe('Ctrl+Shift+S')
    expect(kbdOf(/^Snapping/)).toBe('S')
    expect(kbdOf(/^Play/)).toBe('Space')
    expect(kbdOf(/^Go to start/)).toBe('Home')
    expect(kbdOf(/^Zoom in/)).toBe('Ctrl+=')
    expect(kbdOf('Fit timeline (Shift+Z)')).toBe('Shift+Z')
    // and the clip menu
    fireEvent.contextMenu(document.querySelector('.tl-clip[data-item="va"]')!, { clientX: 50, clientY: 50 })
    const sep = screen.getByRole('menuitem', { name: /Separate audio/ })
    expect(within(sep).getByText('Ctrl Shift S')).toBeTruthy()
  })

  it('the canvas object toolbar and the canvas zoom menu do too', () => {
    S().load({ project: project(), version: 1, projectId: 'p1', demo: true })
    S().select(['va'])
    render(
      <MemoryRouter>
        <TopBar />
        <Canvas />
      </MemoryRouter>,
    )
    expect(kbdOf('Duplicate (Ctrl+D)')).toBe('Ctrl+D')
    expect(kbdOf('Delete (Del)')).toBe('Del')
    expect(kbdOf(/^Undo|^Nothing to undo/)).toBe('Ctrl+Z')
    fireEvent.click(screen.getByRole('button', { name: 'Canvas zoom' }))
    expect(within(screen.getByRole('menuitemradio', { name: /^100%/ })).getByText('Shift 1')).toBeTruthy()
    expect(within(screen.getByRole('menuitemradio', { name: /^Fit to screen/ })).getByText('Shift F')).toBeTruthy()
  })
})
