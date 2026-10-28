// Colour: curves, HSL, LUTs, scopes, paste attributes and adjustment layers (E-20).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { STAGES, addAsset, addItem, createProject, createVideoItem, findItem, mainTrack, type AdjustmentItem, type Project, type VideoItem } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useToasts } from '../../lib/toast'
import { addAdjustment } from '../colourActions'
import { FiltersPanel } from '../panels/FxPanels'
import { PasteAttributesHost, usePasteAttributes } from '../PasteAttributes'
import { PropertiesPanel } from '../PropertiesPanel'
import { describeFrame } from '../Scopes'
import { handleKey } from '../shortcuts'
import { useEditor } from '../store'

const S = () => useEditor.getState()

function project(): Project {
  let p = createProject({ id: 'p1', name: 'Colour', width: 1280, height: 720 })
  p = addAsset(p, { id: 'a', kind: 'video', name: 'beach.mp4', src: 'a.mp4', duration: 30, width: 1280, height: 720, hasAudio: true })
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'v1', duration: 4 }))
  p = addItem(p, createVideoItem(p.assets.a, 4, { id: 'v2', duration: 4, in: 8 }))
  return p
}
const clip = (id = 'v1') => findItem(S().project, id)!.item as VideoItem

function open(p = project(), id = 'v1', tab = 'adjust') {
  S().load({ project: p, version: 1, projectId: p.id, demo: false, workspaceId: 'w1' })
  S().select([id])
  S().set({ activeRightTab: tab })
  return render(<PropertiesPanel />)
}

const cubeFile = (text: string, name = 'Warm.cube') => {
  const f = new File([text], name)
  // jsdom's File has no text()
  Object.defineProperty(f, 'text', { value: () => Promise.resolve(text) })
  return f
}
const INVERT = ['TITLE "inv"', 'LUT_3D_SIZE 2', ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`)))].join('\n')

beforeEach(() => {
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})
afterEach(() => {
  cleanup()
  usePasteAttributes.setState({ open: false })
})

describe('the Colour tab', () => {
  it('is the clip’s colour tab, with the basic adjustments still there', () => {
    open()
    expect(within(document.querySelector<HTMLElement>('.ed-tabs')!).getByRole('button', { name: 'Colour' }).className).toBe('on')
    fireEvent.change(screen.getByRole('slider', { name: 'Contrast' }), { target: { value: '25' } })
    expect(clip().adjust.contrast).toBe(25)
  })

  it('shapes a curve per channel by keyboard: add a point, move it, remove it, reset', () => {
    open()
    const box = screen.getByRole('group', { name: 'Master curve' })
    expect(within(box).getAllByRole('slider').map((s) => s.getAttribute('aria-label'))).toEqual(['Black point', 'White point'])
    // the black point lifts: a faded look
    const black = within(box).getByRole('slider', { name: 'Black point' })
    fireEvent.keyDown(black, { key: 'ArrowUp', shiftKey: true })
    expect(clip().grade?.curves?.master).toEqual([[0, 0.1], [1, 1]])
    fireEvent.click(screen.getByRole('button', { name: 'Add point' }))
    expect(clip().grade!.curves!.master).toHaveLength(3)
    const mid = within(box).getByRole('slider', { name: 'Point 1' })
    fireEvent.keyDown(mid, { key: 'ArrowDown' })
    expect(clip().grade!.curves!.master![1][1]).toBeCloseTo(0.55 - 0.01, 2)
    fireEvent.keyDown(mid, { key: 'Delete' })
    expect(clip().grade!.curves!.master).toHaveLength(2)
    // the end points can't be removed
    fireEvent.keyDown(within(box).getByRole('slider', { name: 'White point' }), { key: 'Delete' })
    expect(clip().grade!.curves!.master).toHaveLength(2)
    // the red channel is its own curve
    fireEvent.click(within(screen.getByRole('group', { name: 'Curve channel' })).getByRole('button', { name: 'Red' }))
    const red = screen.getByRole('group', { name: 'Red curve' })
    fireEvent.keyDown(within(red).getByRole('slider', { name: 'White point' }), { key: 'ArrowDown', shiftKey: true })
    expect(clip().grade!.curves!.r).toEqual([[0, 0], [1, 0.9]])
    expect(within(screen.getByRole('group', { name: 'Curve channel' })).getByRole('button', { name: /Master.*changed/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset all curves' }))
    expect(clip().grade!.curves).toBeUndefined()
  })

  it('a click on the curve box adds a point there', () => {
    open()
    const box = screen.getByRole('group', { name: 'Master curve' })
    box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 180, height: 180, right: 180, bottom: 180, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerDown(box.querySelector('.tc-hit')!, { clientX: 90, clientY: 50 })
    fireEvent.pointerUp(window)
    const pts = clip().grade!.curves!.master!
    expect(pts).toHaveLength(3)
    expect(pts[1][0]).toBeCloseTo(0.5, 2)
    expect(pts[1][1]).toBeCloseTo(1 - 40 / 160, 2)
  })

  it('changes one hue range’s hue, saturation and lightness', () => {
    open()
    fireEvent.click(within(screen.getByRole('group', { name: 'Hue range' })).getByRole('button', { name: 'Blue' }))
    fireEvent.change(screen.getByRole('slider', { name: 'Blue saturation' }), { target: { value: '-60' } })
    fireEvent.change(screen.getByRole('slider', { name: 'Blue hue' }), { target: { value: '20' } })
    expect(clip().grade?.hsl).toEqual({ blue: { h: 20, s: -60, l: 0 } })
    expect(screen.getByRole('button', { name: 'Blue (changed)' }).getAttribute('aria-pressed')).toBe('true')
    // back to neutral: the range goes away
    fireEvent.change(screen.getByRole('slider', { name: 'Blue saturation' }), { target: { value: '0' } })
    fireEvent.change(screen.getByRole('slider', { name: 'Blue hue' }), { target: { value: '0' } })
    expect(clip().grade?.hsl).toBeUndefined()
  })

  it('loads a .cube LUT into the project, sets its intensity, and drops it when no clip uses it', async () => {
    open()
    const input = screen.getByLabelText('LUT file') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [cubeFile(INVERT)] } })
    })
    await waitFor(() => expect(clip().grade?.lut).toBeTruthy())
    const id = clip().grade!.lut!.id
    expect(S().project.luts![id]).toMatchObject({ name: 'Warm', size: 2 })
    expect((screen.getByRole('combobox', { name: 'Look' }) as HTMLSelectElement).value).toBe(id)
    fireEvent.change(screen.getByRole('slider', { name: 'LUT intensity' }), { target: { value: '35' } })
    expect(clip().grade!.lut!.intensity).toBe(35)
    fireEvent.change(screen.getByRole('combobox', { name: 'Look' }), { target: { value: '' } })
    expect(clip().grade?.lut).toBeUndefined()
    expect(S().project.luts).toEqual({})
    // one undo brings the LUT and the clip's use of it back together
    act(() => S().undo())
    expect(clip().grade!.lut!.id).toBe(id)
    expect(S().project.luts![id]).toBeTruthy()
  })

  it('says what is wrong with a file that is not a LUT', async () => {
    open()
    await act(async () => {
      fireEvent.change(screen.getByLabelText('LUT file') as HTMLInputElement, { target: { files: [cubeFile('LUT_3D_SIZE 2\n0 0 0', 'Bad.cube')] } })
    })
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.text).join()).toMatch(/Bad.cube: This .cube file should have 8 entries/))
    expect(clip().grade).toBeUndefined()
  })
})

describe('scopes', () => {
  it('reads the preview’s frame and says what it shows', async () => {
    open()
    const root = document.createElement('div')
    root.dataset.psStage = 'preview'
    document.body.appendChild(root)
    // a dark, blue-leaning frame
    const data = new Uint8ClampedArray(64 * 4)
    for (let i = 0; i < 64; i++) data.set([10, 20, 90, 255], i * 4)
    STAGES.set(root, { snapshot: () => ({ data, width: 8, height: 8 }) as unknown as ImageData })
    fireEvent.click(screen.getByRole('button', { name: 'Scopes' }))
    expect(screen.getByRole('button', { name: 'Waveform' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(screen.getByRole('img', { name: /Waveform: Levels/ })).toBeTruthy())
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/leaning blue/)
    fireEvent.click(screen.getByRole('button', { name: 'Histogram' }))
    expect(screen.getByRole('img', { name: /Histogram:/ })).toBeTruthy()
    root.remove()
  })

  it('names crushed blacks and clipped whites', () => {
    const data = new Uint8ClampedArray(4 * 4)
    data.set([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255])
    const text = describeFrame({ data, width: 4, height: 1 })
    expect(text).toMatch(/50 % crushed to black/)
    expect(text).toMatch(/25 % clipped to white/)
    expect(text).toMatch(/almost no colour/)
  })
})

describe('paste attributes', () => {
  function grade() {
    open()
    fireEvent.change(screen.getByRole('slider', { name: 'Saturation' }), { target: { value: '-40' } })
    fireEvent.keyDown(within(screen.getByRole('group', { name: 'Master curve' })).getByRole('slider', { name: 'Black point' }), { key: 'ArrowUp', shiftKey: true })
    cleanup()
  }

  it('Ctrl Alt V opens the dialog; the checked groups go onto the selected clips; Escape closes it', () => {
    grade()
    S().select(['v1'])
    act(() => handleKey(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })))
    S().select(['v2'])
    render(<PasteAttributesHost />)
    act(() => handleKey(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, altKey: true })))
    const dialog = screen.getByRole('dialog', { name: 'Paste attributes' })
    // focus is in the dialog
    expect(dialog.contains(document.activeElement)).toBe(true)
    const colour = within(dialog).getByRole('checkbox', { name: /Colour/ }) as HTMLInputElement
    const speed = within(dialog).getByRole('checkbox', { name: /Speed/ }) as HTMLInputElement
    expect(colour.checked).toBe(true)
    // speed changes how long the clip is: off unless asked
    expect(speed.checked).toBe(false)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Transform/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Paste' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(clip('v2').adjust.saturation).toBe(-40)
    expect(clip('v2').grade).toEqual(clip('v1').grade)
    expect(S().history.past.at(-1)?.label).toBe('Paste attributes')
    // nothing was pasted: the paste of clips didn't run
    expect(mainTrack(S().project)!.items).toHaveLength(2)

    act(() => handleKey(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, altKey: true })))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says what to do when nothing is copied', () => {
    open()
    S().set({ clipboard: [] })
    render(<PasteAttributesHost />)
    act(() => handleKey(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, altKey: true })))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useToasts.getState().toasts.at(-1)?.text).toMatch(/Copy a clip first/)
  })
})

describe('adjustment layers', () => {
  it('adds one over the selected clips, above every track, and opens its Colour tab', () => {
    open()
    S().select(['v1', 'v2'])
    act(() => addAdjustment())
    const top = S().project.tracks.filter((t) => t.kind !== 'caption').at(-1)!
    const adj = top.items[0] as AdjustmentItem
    expect(adj.type).toBe('adjustment')
    expect([adj.start, adj.duration]).toEqual([0, 8])
    expect(S().selection).toEqual([adj.id])
    expect(S().activeRightTab).toBe('adjust')
    cleanup()
    render(<PropertiesPanel />)
    expect(within(document.querySelector<HTMLElement>('.ed-tabs')!).getAllByRole('button').map((b) => b.textContent)).toEqual(['Colour', 'Layer', ''])
    fireEvent.change(screen.getByRole('slider', { name: 'Saturation' }), { target: { value: '-100' } })
    expect((findItem(S().project, adj.id)!.item as AdjustmentItem).adjust.saturation).toBe(-100)
    fireEvent.click(screen.getByRole('button', { name: 'Layer' }))
    fireEvent.change(screen.getByRole('slider', { name: 'Strength' }), { target: { value: '0.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Film grain' }))
    const now = findItem(S().project, adj.id)!.item as AdjustmentItem
    expect(now.opacity).toBe(0.5)
    expect(now.effects.map((e) => e.type)).toEqual(['grain'])
    // only colour and look effects are offered
    expect(screen.queryByRole('button', { name: 'Camera shake' })).toBeNull()
  })

  it('takes a filter preset from the Filters panel', () => {
    open()
    act(() => addAdjustment())
    const id = S().selection[0]
    render(<FiltersPanel />)
    fireEvent.click(screen.getAllByRole('button').find((b) => b.classList.contains('ed-fxcard') && b.textContent !== 'None')!)
    expect((findItem(S().project, id)!.item as AdjustmentItem).filter).toBeTruthy()
  })
})
