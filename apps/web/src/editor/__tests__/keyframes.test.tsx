// Keyframe editing in the properties panel and on the timeline (E-16).
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addItem, createProject, createShapeItem, findItem, setKeyframe, updateItem, type Project, type ShapeItem } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KeyframeDots } from '../KeyframeDots'
import { setKeyframeClipboard } from '../keyframeActions'
import { PropertiesPanel } from '../PropertiesPanel'
import { handleKey } from '../shortcuts'
import { useEditor } from '../store'

const S = () => useEditor.getState()

/** A shape 1-5 s with x keyframes at 0 and 2 s (clip time) and opacity at 1 s; a second shape 0-4 s. */
function project(): Project {
  let p = addItem(createProject({ id: 'p1', name: 'Kf' }), createShapeItem(1, { id: 's1', duration: 4 }))
  p = addItem(p, createShapeItem(0, { id: 's2', duration: 4 }))
  p = setKeyframe(p, 's1', 'x', 0, 0)
  p = setKeyframe(p, 's1', 'x', 2, 300)
  return setKeyframe(p, 's1', 'opacity', 1, 0.5)
}
const shape = (id = 's1') => findItem(S().project, id)!.item as ShapeItem

function open(p = project(), id = 's1') {
  S().load({ project: p, version: 1, projectId: p.id, demo: false, workspaceId: 'w1' })
  S().select([id])
  S().set({ activeRightTab: 'basic' })
  return render(<PropertiesPanel />)
}

beforeEach(() => {
  // jsdom has no PointerEvent: a mouse event carries the button and position
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
  setKeyframeClipboard(null)
})
afterEach(cleanup)

describe('keyframe lanes', () => {
  it('shows a lane per animated property; a mark is selected, moved a frame with the arrows and removed with Delete', () => {
    open()
    const lane = screen.getByRole('group', { name: 'Position X keyframes' })
    expect(screen.getByRole('group', { name: 'Opacity keyframes' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Scale keyframes' })).toBeNull()
    const mark = within(lane).getByRole('button', { name: /Position X keyframe at 2.00 s, 300 px/ })
    fireEvent.click(mark)
    expect(mark.getAttribute('aria-pressed')).toBe('true')
    expect(S().playhead).toBe(3)
    mark.focus()
    fireEvent.keyDown(mark, { key: 'ArrowRight' })
    expect(shape().keyframes.x!.map((k) => k.t)).toEqual([0, 2.0333])
    // the same button keeps focus while it moves
    expect(document.activeElement).toBe(mark)
    fireEvent.keyDown(mark, { key: 'ArrowLeft', shiftKey: true })
    expect(shape().keyframes.x![1].t).toBeCloseTo(2.0333 - 10 / 30, 3)
    fireEvent.keyDown(document.activeElement!, { key: 'Delete' })
    expect(shape().keyframes.x!.map((k) => k.t)).toEqual([0])
    // the clip itself stays
    expect(findItem(S().project, 's1')).toBeTruthy()
  })

  it('a selected keyframe takes an ease, and a custom curve is shaped with the curve editor', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Position X keyframe at 0.00 s/ }))
    const ease = screen.getByRole('combobox', { name: 'Ease' }) as HTMLSelectElement
    expect(ease.value).toBe('easeInOut')
    // a custom curve starts from the ease it replaces
    fireEvent.change(ease, { target: { value: 'bezier' } })
    expect(shape().keyframes.x![0]).toMatchObject({ ease: 'bezier', bezier: [0.65, 0, 0.35, 1] })
    const p1 = screen.getByRole('slider', { name: 'First control point' })
    fireEvent.keyDown(p1, { key: 'ArrowUp' })
    fireEvent.keyDown(p1, { key: 'ArrowRight', shiftKey: true })
    expect(shape().keyframes.x![0].bezier).toEqual([0.75, 0.01, 0.35, 1])
    fireEvent.click(screen.getByRole('button', { name: 'Out' }))
    expect(shape().keyframes.x![0].bezier).toEqual([0.33, 1, 0.68, 1])
    fireEvent.change(screen.getByRole('combobox', { name: 'Ease' }), { target: { value: 'hold' } })
    expect(shape().keyframes.x![0].ease).toBe('hold')
    expect(shape().keyframes.x![0].bezier).toBeUndefined()
    expect(screen.queryByRole('slider', { name: 'First control point' })).toBeNull()
    // the last keyframe of a property has nothing to ease into
    fireEvent.click(screen.getByRole('button', { name: /Position X keyframe at 2.00 s/ }))
    expect((screen.getByRole('combobox', { name: 'Ease' }) as HTMLSelectElement).disabled).toBe(true)
  })

  it('time and value of a keyframe can be typed', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Opacity keyframe at 1.00 s/ }))
    const time = screen.getByRole('textbox', { name: 'Time' })
    fireEvent.focus(time)
    fireEvent.change(time, { target: { value: '1.5' } })
    fireEvent.blur(time)
    expect(shape().keyframes.opacity![0].t).toBe(1.5)
    const value = screen.getByRole('textbox', { name: 'Value' })
    fireEvent.focus(value)
    fireEvent.change(value, { target: { value: '80' } })
    fireEvent.blur(value)
    expect(shape().keyframes.opacity![0].value).toBe(0.8)
  })

  it('previous and next keyframe, by button and by Alt [ / Alt ]', () => {
    open()
    act(() => S().setPlayhead(1))
    fireEvent.click(screen.getByRole('button', { name: 'Next keyframe' }))
    expect(S().playhead).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Next keyframe' }))
    expect(S().playhead).toBe(3)
    act(() => handleKey(new KeyboardEvent('keydown', { key: '[', code: 'BracketLeft', altKey: true })))
    expect(S().playhead).toBe(2)
    act(() => handleKey(new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', altKey: true })))
    expect(S().playhead).toBe(3)
    expect((screen.getByRole('button', { name: 'Next keyframe' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('copies keyframes and pastes them onto another clip at the playhead', () => {
    const view = open()
    fireEvent.click(screen.getByRole('button', { name: 'Copy keyframes' }))
    view.unmount()
    open(S().project, 's2')
    act(() => S().setPlayhead(1))
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    const s2 = shape('s2')
    expect(s2.keyframes.x!.map((k) => [k.t, k.value])).toEqual([[1, 0], [3, 300]])
    expect(s2.keyframes.opacity!.map((k) => k.t)).toEqual([2])
    expect(S().history.past.at(-1)!.label).toBe('Paste keyframes')
  })

  it('a locked clip shows its keyframes but takes no edits', () => {
    open(updateItem<ShapeItem>(project(), 's1', { locked: true }))
    const mark = screen.getByRole('button', { name: /Position X keyframe at 2.00 s/ })
    fireEvent.keyDown(mark, { key: 'ArrowRight' })
    expect(shape().keyframes.x!.map((k) => k.t)).toEqual([0, 2])
    expect(screen.getByRole('button', { name: /Copy keyframe/ }).matches(':disabled')).toBe(true)
  })
})

describe('keyframe diamonds on the timeline', () => {
  it('dragging a diamond moves every keyframe at that time, frame by frame, as one undo step', () => {
    const p = setKeyframe(project(), 's1', 'opacity', 2, 1)
    S().load({ project: p, version: 1, projectId: p.id, demo: false, workspaceId: 'w1' })
    render(<KeyframeDots item={findItem(p, 's1')!.item} times={[0, 1, 2]} zoom={100} locked={false} />)
    const dot = screen.getByTitle(/Keyframe at 2.00s/)
    fireEvent.pointerDown(dot, { button: 0, clientX: 200 })
    expect(S().selection).toEqual(['s1'])
    expect(S().playhead).toBe(3)
    fireEvent.pointerMove(window, { clientX: 250 })
    fireEvent.pointerMove(window, { clientX: 280 })
    fireEvent.pointerUp(window)
    expect(shape().keyframes.x!.map((k) => k.t)).toEqual([0, 2.8])
    expect(shape().keyframes.opacity!.map((k) => k.t)).toEqual([1, 2.8])
    expect(S().playhead).toBeCloseTo(3.8, 6)
    S().undo()
    expect(shape().keyframes.x!.map((k) => k.t)).toEqual([0, 2])
  })

  it("a locked clip's diamonds only go to the keyframe", () => {
    const p = updateItem<ShapeItem>(project(), 's1', { locked: true })
    S().load({ project: p, version: 1, projectId: p.id, demo: false, workspaceId: 'w1' })
    render(<KeyframeDots item={findItem(p, 's1')!.item} times={[0, 2]} zoom={100} locked />)
    fireEvent.pointerDown(screen.getByTitle('Keyframe at 2.00s'), { button: 0, clientX: 200 })
    fireEvent.pointerMove(window, { clientX: 300 })
    fireEvent.pointerUp(window)
    expect(shape().keyframes.x!.map((k) => k.t)).toEqual([0, 2])
    expect(S().playhead).toBe(3)
  })
})
