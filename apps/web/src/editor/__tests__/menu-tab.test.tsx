// The shared Menu and Tab (R3-E): a popover keeps Tab among its own controls (the transition popover is usable by
// keyboard), a menu closes on Tab without choosing anything and focus moves on from its button (WAI-ARIA menu).
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, findItem, type Asset, type Project, type VisualItem } from '@producer/core'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Menu, MenuItem } from '../controls'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'

const S = () => useEditor.getState()
const video = (id: string): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration: 10, width: 1920, height: 1080, hasAudio: true })

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})
afterEach(cleanup)

describe('a menu closes on Tab', () => {
  function Bar({ onPick }: { onPick: () => void }) {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button>Before</button>
        <button onClick={() => setOpen(true)}>Zoom</button>
        <Menu open={open} onClose={() => setOpen(false)} label="Zoom">
          <MenuItem label="Fit" onClick={onPick} />
          <MenuItem label="50%" onClick={onPick} />
        </Menu>
        <button>After</button>
      </>
    )
  }

  it('Tab closes it, picks nothing, and moves on to what follows its button', () => {
    const pick = vi.fn()
    render(<Bar onPick={pick} />)
    const opener = screen.getByRole('button', { name: 'Zoom' })
    act(() => opener.focus())
    fireEvent.click(opener)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '50%' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }))
    expect(pick).not.toHaveBeenCalled()
  })

  it('Shift+Tab closes it and moves back to what comes before its button', () => {
    render(<Bar onPick={() => {}} />)
    const opener = screen.getByRole('button', { name: 'Zoom' })
    act(() => opener.focus())
    fireEvent.click(opener)
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Before' }))
  })
})

describe('a popover keeps Tab inside', () => {
  function Pop() {
    const [open, setOpen] = useState(false)
    const [pick, setPick] = useState('b')
    return (
      <>
        <button onClick={() => setOpen(true)}>Options</button>
        <Menu open={open} onClose={() => setOpen(false)} role="dialog" label="Options">
          <button aria-label="Close" onClick={() => setOpen(false)}>x</button>
          {['a', 'b'].map((x) => (
            <button key={x} aria-pressed={pick === x} onClick={() => setPick(x)}>{x.toUpperCase()}</button>
          ))}
          <input aria-label="Length" />
        </Menu>
      </>
    )
  }

  it('opens on the chosen option; Tab and Shift+Tab go round its controls; Escape gives focus back', () => {
    render(<Pop />)
    const opener = screen.getByRole('button', { name: 'Options' })
    act(() => opener.focus())
    fireEvent.click(opener)
    const box = screen.getByRole('dialog', { name: 'Options' })
    const [close, a, b] = within(box).getAllByRole('button')
    const len = within(box).getByRole('textbox', { name: 'Length' })
    expect(document.activeElement).toBe(b)
    fireEvent.keyDown(b, { key: 'Tab' })
    expect(document.activeElement).toBe(len)
    fireEvent.keyDown(len, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(len)
    fireEvent.keyDown(len, { key: 'Tab', shiftKey: true })
    fireEvent.keyDown(b, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(a)
    // still open, and a choice made by keyboard sticks
    fireEvent.click(a)
    expect(a.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('dialog', { name: 'Options' })).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})

describe('the transition popover by keyboard', () => {
  function twoClips(): Project {
    let p = createProject({ id: 'p1' })
    p = addAsset(p, video('a'))
    p = addAsset(p, video('b'))
    p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
    return addItem(p, createVideoItem(p.assets.b, 10, { id: 'vb' }))
  }

  it('Tab reaches the duration and Remove without closing it, and the clip stays selected', () => {
    S().load({ project: twoClips(), version: 1, projectId: 'p1', demo: true })
    render(<Timeline />)
    act(() => S().select(['va']))
    fireEvent.contextMenu(document.querySelector('.tl-clip[data-item="va"]')!, { clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add transition' }))
    const box = screen.getByRole('dialog', { name: 'Transition' })
    const tr = () => (findItem(S().project, 'va')!.item as VisualItem).transitionOut
    expect(tr()?.type).toBe('crossfade')
    // focus starts on the chosen look
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true')
    const slider = within(box).getByRole('slider', { name: 'Duration' })
    const remove = within(box).getByRole('button', { name: /Remove transition/ })
    const seen = new Set<Element | null>()
    for (let i = 0; i < 30 && !(seen.has(slider) && seen.has(remove)); i++) {
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
      seen.add(document.activeElement)
      expect(box.contains(document.activeElement)).toBe(true)
    }
    expect(seen.has(slider) && seen.has(remove)).toBe(true)
    expect(screen.getByRole('dialog', { name: 'Transition' })).toBe(box)
    expect(tr()?.type).toBe('crossfade')
    expect(S().selection).toEqual(['va'])
  })

  it('Tab out of the clip menu closes it and keeps the clip selected', () => {
    S().load({ project: twoClips(), version: 1, projectId: 'p1', demo: true })
    render(<Timeline />)
    act(() => S().select(['vb']))
    fireEvent.contextMenu(document.querySelector('.tl-clip[data-item="vb"]')!, { clientX: 100, clientY: 100 })
    const menu = screen.getByRole('menu', { name: 'Clip' })
    fireEvent.keyDown(within(menu).getAllByRole('menuitem')[0], { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(S().selection).toEqual(['vb'])
    expect(S().history.past).toHaveLength(0)
  })
})
