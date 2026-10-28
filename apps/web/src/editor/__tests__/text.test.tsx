// The Text tab and text on the canvas (E-19): word styles, effects, shrink to fit, templates on a portrait canvas,
// characters the export can't draw.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addItem, createProject, createTextItem, findItem, setCanvasSize, updateItem, type Project, type TextItem } from '@producer/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as A from '../actions'
import { Canvas } from '../Canvas'
import { PropertiesPanel } from '../PropertiesPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()
const text = () => findItem(S().project, 't')!.item as TextItem

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})
afterEach(cleanup)

function project(words = 'Make it pop', over: Partial<TextItem> = {}): Project {
  return addItem(createProject({ id: 'p1', name: 'Text' }), createTextItem(0, 'heading', { id: 't', text: words, ...over }))
}

function open(p: Project) {
  S().load({ project: p, version: 1, projectId: p.id, demo: false, workspaceId: 'w1' })
  S().select(['t'])
  S().set({ activeRightTab: 'text' })
  return render(<PropertiesPanel />)
}

function typeColour(input: HTMLElement, v: string) {
  fireEvent.change(input, { target: { value: v } })
  fireEvent.blur(input)
}

describe('word styles', () => {
  it('a word picked gets its own colour and weight; Shift+click picks a run; Clear takes it off', () => {
    open(project())
    const words = screen.getByRole('group', { name: 'Words' })
    fireEvent.click(within(words).getByRole('button', { name: 'pop' }))
    const ctl = screen.getByRole('group', { name: 'Style for “pop”' })
    typeColour(within(ctl).getByRole('textbox', { name: 'Colour' }), '#35e0ff')
    expect(text().spans).toEqual([{ start: 8, end: 11, color: '#35e0ff' }])
    // the heading is weight 800: Bold takes this word down to regular
    fireEvent.click(within(ctl).getByRole('button', { name: 'Bold' }))
    expect(text().spans).toEqual([{ start: 8, end: 11, color: '#35e0ff', fontWeight: 400 }])
    fireEvent.click(within(words).getByRole('button', { name: 'it' }), { shiftKey: true })
    const run = screen.getByRole('group', { name: 'Style for “it pop”' })
    fireEvent.click(within(run).getByRole('button', { name: 'Italic' }))
    expect(text().spans).toEqual([
      { start: 5, end: 8, italic: true },
      { start: 8, end: 11, color: '#35e0ff', fontWeight: 400, italic: true },
    ])
    fireEvent.click(within(run).getByRole('button', { name: /Clear/ }))
    expect(text().spans).toBeUndefined()
  })

  it('typing in the Content box keeps the word styles on their words', () => {
    open(project('Make it pop', { spans: [{ start: 8, end: 11, color: '#ff0000' }] }))
    expect(screen.getByRole('button', { name: 'pop' }).style.color).toBe('rgb(255, 0, 0)')
    const box = document.querySelector('.ed-textarea') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'Now make it pop' } })
    expect(text()).toMatchObject({ text: 'Now make it pop', spans: [{ start: 12, end: 15, color: '#ff0000' }] })
  })
})

describe('text effects', () => {
  it('a preset sets its look sized for the text, and the next one replaces it', () => {
    open(project())
    const fx = screen.getByRole('group', { name: 'Text effects' })
    fireEvent.click(within(fx).getByRole('button', { name: /Outline/ }))
    const size = text().style.fontSize
    expect(text().style.stroke).toEqual({ color: '#000000', width: +(size * 0.06).toFixed(2) })
    expect(text().effect).toBe('outline')
    expect(within(fx).getByRole('button', { name: /Outline/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(fx).getByRole('button', { name: /Sunset/ }))
    expect(text().style.stroke).toBeUndefined()
    expect(text().style.gradient).toEqual({ from: '#ffd84d', to: '#ff4f8b', angle: 90 })
    expect(S().history.past.at(-1)!.label).toBe('Text effect Sunset')
  })
})

describe('shrink to fit', () => {
  it('the toggle gives the text a box height to fit inside; the canvas handles change it', () => {
    open(project())
    fireEvent.click(screen.getByRole('switch', { name: /Shrink to fit box/ }))
    const st = text().style
    expect(st.fit).toEqual({ height: Math.round(st.fontSize * st.lineHeight * 2) })
    expect(screen.getByRole('slider', { name: 'Box height' })).toBeTruthy()
    cleanup()
    S().set({ canvasZoom: 1 })
    render(<Canvas />)
    const h0 = text().style.fit!.height
    fireEvent.pointerDown(document.querySelector('.cv-handle.side.s')!, { button: 0, clientX: 0, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 0, clientY: 150 })
    fireEvent.pointerUp(window)
    expect(text().style.fit!.height).toBe(h0 + 100)
    cleanup()
    open(S().project)
    fireEvent.click(screen.getByRole('switch', { name: /Shrink to fit box/ }))
    expect(text().style.fit).toBeUndefined()
  })
})

describe('characters the export cannot draw', () => {
  it('warns about boxes, about another font, and about system-drawn emoji', () => {
    open(project('Hello مرحبا'))
    expect(screen.getByText(/The export can't draw/).textContent).toContain('م ر ح ب ا')
    cleanup()
    open(updateItem<TextItem>(project('Привет 🎉'), 't', { style: { ...createTextItem(0).style, fontFamily: 'Bebas Neue' } }))
    expect(screen.getByText(/Bebas Neue has no/)).toBeTruthy()
    expect(screen.getByText(/Noto fonts/)).toBeTruthy()
    expect(screen.queryByText(/The export can't draw/)).toBeNull()
    cleanup()
    open(project('All good'))
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('templates on the canvas shape', () => {
  it('a lower third on a 9:16 canvas is sized for it and sits above the platform captions', () => {
    S().load({ project: setCanvasSize(createProject({ id: 'p2' }), 1080, 1920), version: 1, projectId: 'p2', demo: false, workspaceId: 'w1' })
    const id = A.addText('lower-third', 0)
    const t = findItem(S().project, id)!.item as TextItem
    expect(t.style.boxWidth).toBeLessThanOrEqual(1080 * 0.9)
    expect(t.transform.y).toBe(384)
    expect(t.transform.x - t.style.boxWidth / 2).toBeGreaterThan(-540)
  })
})
