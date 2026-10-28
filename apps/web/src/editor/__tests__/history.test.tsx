// The history list (E-25): undo steps by label, the current one marked; choosing one jumps back or forward to it.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, mainTrack, splitAt, updateItem, type Asset, type Project } from '@producer/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HistoryButton, historySteps, jumpToStep } from '../HistoryPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()
const video = (id: string): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration: 10, width: 1920, height: 1080, hasAudio: true })

beforeAll(() => {
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})
afterEach(cleanup)

function start(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, video('a'))
  return addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
}

/** Three edits: Split, Opacity, Rename. */
function edited() {
  S().load({ project: start(), version: 1, projectId: 'p1', demo: true })
  S().commit(splitAt(S().project, 4), 'Split')
  S().commit(updateItem(S().project, 'va', { opacity: 0.5 }), 'Opacity')
  S().commit({ ...S().project, name: 'Renamed' }, 'Rename project')
}

describe('the history list (E-25)', () => {
  it('lists the steps by label, oldest first, and jumps to any of them', () => {
    edited()
    expect(historySteps(S()).map((s) => s.label)).toEqual(['Opened the project', 'Split', 'Opacity', 'Rename project'])
    jumpToStep(1)
    expect(S().project.name).not.toBe('Renamed')
    expect(mainTrack(S().project)!.items).toHaveLength(2)
    expect((mainTrack(S().project)!.items[0] as { opacity: number }).opacity).toBe(1)
    // the undone steps are still listed, after the current one
    expect(historySteps(S()).map((s) => s.label)).toEqual(['Opened the project', 'Split', 'Opacity', 'Rename project'])
    jumpToStep(3)
    expect(S().project.name).toBe('Renamed')
    jumpToStep(0)
    expect(mainTrack(S().project)!.items).toHaveLength(1)
  })

  it('opens on the current step; the arrows move through it and choosing a step jumps there; Escape closes it', () => {
    edited()
    render(<HistoryButton />)
    const button = screen.getByRole('button', { name: 'History' })
    act(() => button.focus())
    fireEvent.click(button)
    const menu = screen.getByRole('menu', { name: 'History' })
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent)).toEqual(['Opened the project', 'Split', 'Opacity', 'Rename project'])
    expect(items[3].getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(items[3])
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.click(document.activeElement!)
    expect(S().history.past).toHaveLength(1)
    expect(screen.getAllByRole('menuitemradio')[1].getAttribute('aria-checked')).toBe('true')
    // still open: another step can be chosen straight away
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Rename project' }))
    expect(S().project.name).toBe('Renamed')
    fireEvent.keyDown(screen.getByRole('menu', { name: 'History' }), { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'History' })).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('has nothing to show before the first change', () => {
    S().load({ project: start(), version: 1, projectId: 'p1', demo: true })
    render(<HistoryButton />)
    expect((screen.getByRole('button', { name: 'History' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
