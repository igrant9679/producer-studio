// The canvas (E-18): snapping while moving, rulers and guides, safe zones, group transforms, align and distribute,
// crop handles.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addAsset, addItem, createImageItem, createProject, createShapeItem, findItem, type ImageItem, type Project, type ShapeItem } from '@producer/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Canvas } from '../Canvas'
import { useCanvasView } from '../canvasView'
import { PropertiesPanel } from '../PropertiesPanel'
import { handleKey } from '../shortcuts'
import { useEditor } from '../store'

const S = () => useEditor.getState()

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})

/** What the pointer is over: jsdom has no layout, so the test says which layer. */
let under: string | null = null
beforeEach(() => {
  localStorage.clear()
  useCanvasView.setState({ rulers: false, safeZone: null, guides: { v: [], h: [] }, projectId: '' })
  under = null
  document.elementsFromPoint = () => {
    const el = under ? document.querySelector(`.cv-stage [data-ps-layer="${under}"]`) : null
    return el ? [el] : []
  }
})
afterEach(cleanup)

/** 1920 × 1080; 400 × 240 shapes centred at x 0 (s1), 600 (s2) and, when asked, 100 (s3). */
function project(three = false): Project {
  let p = createProject({ id: 'p1', name: 'Canvas' })
  p = addItem(p, createShapeItem(0, { id: 's1', duration: 5 }))
  p = addItem(p, createShapeItem(0, { id: 's2', duration: 5, transform: { x: 600, y: 0, scale: 1, rotation: 0 } }))
  if (three) p = addItem(p, createShapeItem(0, { id: 's3', duration: 5, transform: { x: 100, y: 0, scale: 1, rotation: 0 } }))
  return p
}
const item = <T,>(id: string) => findItem(S().project, id)!.item as T

function open(p: Project, selection: string[]) {
  S().load({ project: p, version: 1, projectId: p.id, demo: false, workspaceId: 'w1' })
  S().select(selection)
  S().set({ canvasZoom: 1, snapping: true })
  return render(<Canvas />)
}

/** Press on a layer, move by (dx, dy) screen px (at zoom 1, canvas px too) and, unless `hold`, let go. */
function drag(id: string, dx: number, dy = 0, opts: { altKey?: boolean; hold?: boolean } = {}) {
  under = id
  const layer = document.querySelector(`.cv-stage [data-ps-layer="${id}"]`)!
  fireEvent.pointerDown(layer, { button: 0, clientX: 500, clientY: 300 })
  fireEvent.pointerMove(window, { clientX: 500 + dx / 2, clientY: 300 + dy / 2, altKey: opts.altKey })
  fireEvent.pointerMove(window, { clientX: 500 + dx, clientY: 300 + dy, altKey: opts.altKey })
  if (!opts.hold) fireEvent.pointerUp(window)
}

describe('snapping while moving', () => {
  it("an edge snaps to another object's edge, with a line where they meet; Alt moves freely", () => {
    open(project(), ['s1'])
    // s1's right edge (1160) goes to 1357, 3 px short of s2's left edge (1360) (its left edge meets the centre too)
    drag('s1', 197, 0, { hold: true })
    expect(item<ShapeItem>('s1').transform.x).toBe(200)
    const lines = [...document.querySelectorAll<HTMLElement>('.cv-guide.v')].map((l) => l.style.left)
    expect(lines.sort()).toEqual(['1360px', '960px'])
    fireEvent.pointerUp(window)
    expect(document.querySelector('.cv-guide')).toBeNull()
    S().undo()
    drag('s1', 197, 0, { altKey: true })
    expect(item<ShapeItem>('s1').transform.x).toBe(197)
  })

  it('the centre snaps to the canvas centre, and with snapping off nothing snaps', () => {
    open(project(), ['s1'])
    drag('s1', 4, -3)
    expect(item<ShapeItem>('s1').transform).toMatchObject({ x: 0, y: 0 })
    act(() => S().set({ snapping: false }))
    drag('s1', 4, -3)
    expect(item<ShapeItem>('s1').transform).toMatchObject({ x: 4, y: -3 })
  })

  it('snaps to a guide and to the safe area', () => {
    open(project(), ['s1'])
    act(() => useCanvasView.setState({ rulers: true, guides: { v: [300], h: [] } }))
    // s1's left edge 760 -> 303
    drag('s1', -457)
    expect(item<ShapeItem>('s1').transform.x).toBe(-460)
    S().undo()
    act(() => useCanvasView.getState().setSafeZone('tiktok'))
    expect(document.querySelector('.cv-safe')?.textContent).toContain('TikTok safe area')
    // tiktok on 1920 × 1080: the clear area starts at y 86; s1's top (420) -> 88
    drag('s1', 0, -332)
    expect(item<ShapeItem>('s1').transform.y).toBe(-334)
  })
})

describe('rulers and guides', () => {
  it('the view bar turns rulers on (Shift R too); Enter on a ruler adds a guide, arrows move it, Delete removes it', () => {
    open(project(), [])
    const toggle = screen.getByRole('button', { name: 'Rulers and guides' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const top = screen.getByRole('button', { name: /Top ruler/ })
    fireEvent.keyDown(top, { key: 'Enter' })
    const guide = screen.getByRole('slider', { name: 'Horizontal guide' })
    expect(guide.getAttribute('aria-valuenow')).toBe('540')
    fireEvent.keyDown(guide, { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Horizontal guide' }), { key: 'ArrowUp', shiftKey: true })
    expect(useCanvasView.getState().guides.h).toEqual([531])
    // kept for this project in this browser
    expect(JSON.parse(localStorage.getItem('ps.guides.p1')!)).toEqual({ v: [], h: [531] })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Horizontal guide' }), { key: 'Delete' })
    expect(screen.queryByRole('slider', { name: 'Horizontal guide' })).toBeNull()
    expect(document.activeElement).toBe(top)
    act(() => handleKey(new KeyboardEvent('keydown', { key: 'R', shiftKey: true })))
    expect(useCanvasView.getState().rulers).toBe(false)
    expect(screen.queryByRole('button', { name: /Top ruler/ })).toBeNull()
  })

  it('a guide is dragged out of the left ruler, moved, and dragged back off the canvas to remove it', () => {
    open(project(), [])
    act(() => useCanvasView.getState().setRulers(true))
    fireEvent.pointerDown(screen.getByRole('button', { name: /Left ruler/ }), { button: 0, clientX: -10, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 300, clientY: 100 })
    fireEvent.pointerUp(window)
    expect(useCanvasView.getState().guides.v).toEqual([300])
    const g = screen.getByRole('slider', { name: 'Vertical guide' })
    fireEvent.pointerDown(g, { button: 0, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 420, clientY: 100 })
    fireEvent.pointerUp(window)
    expect(useCanvasView.getState().guides.v).toEqual([420])
    fireEvent.pointerDown(screen.getByRole('slider', { name: 'Vertical guide' }), { button: 0, clientX: 420, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: -8, clientY: 100 })
    fireEvent.pointerUp(window)
    expect(useCanvasView.getState().guides.v).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Rulers and guides' }))
    expect(screen.queryByRole('button', { name: 'Clear guides' })).toBeNull()
  })
})

describe('several objects selected', () => {
  it('dragging one moves them all as one undo step; a click without a drag selects just that one', () => {
    open(project(), ['s1', 's2'])
    drag('s1', 50, 20, { altKey: true })
    expect(item<ShapeItem>('s1').transform).toMatchObject({ x: 50, y: 20 })
    expect(item<ShapeItem>('s2').transform).toMatchObject({ x: 650, y: 20 })
    expect(S().history.past.at(-1)!.label).toBe('Move objects')
    expect(S().selection).toEqual(['s1', 's2'])
    S().undo()
    expect(item<ShapeItem>('s2').transform.x).toBe(600)
    under = 's2'
    fireEvent.pointerDown(document.querySelector('.cv-stage [data-ps-layer="s2"]')!, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(window)
    expect(S().selection).toEqual(['s2'])
  })

  it('the arrow keys nudge every selected object', () => {
    open(project(), ['s1', 's2'])
    fireEvent.keyDown(document.querySelector('.cv-wrap')!, { key: 'ArrowRight', shiftKey: true })
    expect([item<ShapeItem>('s1').transform.x, item<ShapeItem>('s2').transform.x]).toEqual([10, 610])
  })

  it('a corner scales the group about its centre, the handle rotates it', () => {
    open(project(), ['s1', 's2'])
    const box = document.querySelector('[data-group-box]')!
    // bounds 760..1760 × 420..660: centre (1260, 540); from its corner to twice as far
    fireEvent.pointerDown(box.querySelector('.cv-handle.corner.se')!, { button: 0, clientX: 1760, clientY: 660 })
    fireEvent.pointerMove(window, { clientX: 2260, clientY: 780 })
    fireEvent.pointerUp(window)
    expect(item<ShapeItem>('s1').transform).toMatchObject({ x: -300, y: 0, scale: 2 })
    expect(item<ShapeItem>('s2').transform).toMatchObject({ x: 900, y: 0, scale: 2 })
    S().undo()
    fireEvent.pointerDown(document.querySelector('[data-group-box] .cv-handle.rot')!, { button: 0, clientX: 1260, clientY: 300 })
    // a quarter turn clockwise around (1260, 540)
    fireEvent.pointerMove(window, { clientX: 1500, clientY: 540 })
    fireEvent.pointerUp(window)
    expect(item<ShapeItem>('s1').transform).toMatchObject({ x: 300, y: -300, rotation: 90 })
    expect(item<ShapeItem>('s2').transform).toMatchObject({ x: 300, y: 300, rotation: 90 })
  })

  it('the group toolbar aligns and distributes', () => {
    let p = project(true)
    p = { ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === 's2' ? { ...i, transform: { ...(i as ShapeItem).transform, y: 100 } } : i)) })) }
    open(p, ['s1', 's2', 's3'])
    const bar = screen.getByRole('toolbar', { name: '3 objects selected' })
    fireEvent.click(within(bar).getByRole('button', { name: 'Align top' }))
    expect(item<ShapeItem>('s2').transform.y).toBe(0)
    fireEvent.click(within(bar).getByRole('button', { name: 'Distribute horizontally' }))
    // lefts 760, 860, 1360: s3 (the middle one) goes to 1060
    expect(item<ShapeItem>('s3').transform.x).toBe(300)
    expect(S().history.past.at(-1)!.label).toBe('Distribute horizontally')
  })
})

describe('align one object to the canvas', () => {
  it('from the Transform tab', () => {
    S().load({ project: project(), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
    S().select(['s1'])
    S().set({ activeRightTab: 'basic' })
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Align left of the canvas' }))
    expect(item<ShapeItem>('s1').transform.x).toBe(-760)
    fireEvent.click(screen.getByRole('button', { name: 'Align bottom of the canvas' }))
    expect(item<ShapeItem>('s1').transform.y).toBe(420)
  })
})

describe('crop handles', () => {
  it('Crop shows a handle on each edge; dragging one inwards crops that side', () => {
    let p = createProject({ id: 'p1' })
    p = addAsset(p, { id: 'im', kind: 'image', name: 'a.png', src: '/a.png', width: 1920, height: 1080 })
    p = addItem(p, createImageItem(p.assets.im, 0, { id: 'i1' }))
    open(p, ['i1'])
    expect(document.querySelector('[data-crop]')).toBeNull()
    const cropBtn = screen.getByRole('button', { name: 'Crop' })
    fireEvent.click(cropBtn)
    expect(cropBtn.getAttribute('aria-pressed')).toBe('true')
    const left = document.querySelector('[data-crop="left"]')!
    fireEvent.pointerDown(left, { button: 0, clientX: 0, clientY: 540 })
    fireEvent.pointerMove(window, { clientX: 96, clientY: 540 })
    fireEvent.pointerUp(window)
    expect(item<ImageItem>('i1').crop).toEqual({ left: 0.05, top: 0, right: 0, bottom: 0 })
    const bottom = document.querySelector('[data-crop="bottom"]')!
    fireEvent.pointerDown(bottom, { button: 0, clientX: 960, clientY: 1080 })
    fireEvent.pointerMove(window, { clientX: 960, clientY: 1000 })
    fireEvent.pointerUp(window)
    expect(item<ImageItem>('i1').crop!.bottom).toBeGreaterThan(0)
  })
})
