// Viewer mode: someone who only views the project's space opens the editor read-only. The store refuses every edit
// (one guard), and the write controls are disabled with the viewer tooltip, across the timeline (drags, trims, the
// context menu, track headers, markers, keyframe dots), the canvas, the panels, the top bar, the keyboard and the
// assistant. Playing, scrubbing, selecting and looking still work.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addAsset, addItem, addMarker, createProject, createShapeItem, createTextItem, createVideoItem, findItem, type Asset, type AssistantResult, type Project, type User, type Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useToasts } from '../../lib/toast'
import { TooltipLayer } from '../../lib/tooltip'
import { systemApi } from '../../shell/system'
import { viewOnlyTip } from '../../shell/ui'
import { Canvas } from '../Canvas'
import { AssetPanel } from '../LeftPanel'
import { AssistantPanel } from '../panels/AssistantPanel'
import { PropertiesPanel } from '../PropertiesPanel'
import { handleKey } from '../shortcuts'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'
import { TopBar } from '../TopBar'
import { uploadFiles, useLibrary } from '../uploads'
import { readOnlyFor, startViewerMode } from '../viewer'

const S = () => useEditor.getState()
const toasts = () => useToasts.getState().toasts.map((t) => t.text)
const me = { id: 'u1', email: 'v@example.com', name: 'Vi', avatarColor: '#fff', createdAt: 0 } as User
const space = (role: Workspace['role']): Workspace => ({ id: 'w1', name: 'Client review', role, personal: false, memberCount: 3 })
const TIP = viewOnlyTip(space('viewer'))

const clip: Asset = {
  id: 'as_a',
  kind: 'video',
  name: 'talk.mp4',
  src: '/api/media/as_a/source',
  duration: 10,
  width: 1920,
  height: 1080,
  hasAudio: true,
  transcript: { language: 'en', engine: 'test', segments: [{ start: 0, end: 2, text: 'one two', words: [{ w: 'one', start: 0.2, end: 0.6 }, { w: 'two', start: 1, end: 1.4 }] }] },
}

function project(): Project {
  let p = addAsset(createProject({ id: 'p1', name: 'Cut' }), clip)
  p = addItem(p, createVideoItem(clip, 0, { id: 'v1' }))
  p = addItem(p, createShapeItem(0, { id: 's1', duration: 5 }))
  p = addItem(p, createTextItem(0, 'heading', { id: 't1', duration: 3 }))
  return addMarker(p, 4, { name: 'Beat' }).project
}

let stop: () => void = () => undefined
let under: string | null = null

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
  Element.prototype.scrollTo ??= () => undefined
})

/** Open the project as `role` in its space, with viewer mode following the session as in the editor. */
function open(role: Workspace['role'] = 'viewer') {
  useSession.setState({ status: 'ready', user: me, workspaces: [space(role)], workspaceId: 'w1' } as never)
  S().load({ project: project(), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  stop = startViewerMode()
  S().set({ zoom: 80, canvasZoom: 1, snapping: true })
}

beforeEach(() => {
  useToasts.setState({ toasts: [] })
  under = null
  document.elementsFromPoint = () => {
    const el = under ? document.querySelector(`.cv-stage [data-ps-layer="${under}"]`) : null
    return el ? [el] : []
  }
  vi.spyOn(systemApi, 'aiSettings').mockRejectedValue(new Error('no settings in tests'))
})
afterEach(() => {
  cleanup()
  stop()
  S().set({ readOnly: false, readOnlyTip: undefined })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the viewer flag', () => {
  it('follows the role in the project’s space, live, and never applies to the demo', () => {
    open('viewer')
    expect(S().readOnly).toBe(true)
    expect(S().readOnlyTip).toBe(TIP)
    // an owner makes them an editor: the session's spaces refresh and the editor opens up
    act(() => useSession.setState({ workspaces: [space('editor')] }))
    expect(S().readOnly).toBe(false)
    act(() => useSession.setState({ workspaces: [space('viewer')] }))
    expect(S().readOnly).toBe(true)
    // the demo has no space
    S().load({ project: project(), version: 0, projectId: 'demo', demo: true })
    expect(S().readOnly).toBe(false)
    expect(readOnlyFor(undefined).readOnly).toBe(false)
    // a space the session doesn't list yet: the server decides
    expect(readOnlyFor('w_unknown').readOnly).toBe(false)
  })
})

describe('the store refuses every edit from a viewer', () => {
  it('commit, undo, redo and replaceSilently change nothing and say who can edit, once per burst', () => {
    open()
    const before = S().project
    for (let i = 0; i < 5; i++) S().commit({ ...before, name: `x${i}` }, 'Rename')
    S().replaceSilently({ ...before, name: 'quiet' })
    S().undo()
    S().redo()
    expect(S().project).toBe(before)
    expect(S().history.past).toHaveLength(0)
    expect(S().saveState).toBe('saved')
    expect(toasts()).toEqual([TIP])
  })

  it('a role lowered mid-session keeps the history but refuses to step through it', () => {
    open('editor')
    S().commit({ ...S().project, name: 'mine' }, 'Rename')
    act(() => useSession.setState({ workspaces: [space('viewer')] }))
    S().undo()
    expect(S().project.name).toBe('mine')
  })

  it('selection, the playhead and play still work; a media record arrives without anything to save', () => {
    open()
    S().select(['v1'])
    S().setPlayhead(3)
    S().setPlaying(true)
    expect(S().selection).toEqual(['v1'])
    expect(S().playhead).toBe(3)
    expect(S().playing).toBe(true)
    S().updateMedia({ id: 'as_a', duration: 11 })
    expect(S().project.assets.as_a.duration).toBe(11)
    expect(S().saveState).toBe('saved')
  })
})

describe('keyboard shortcuts', () => {
  const key = (k: string, more: Partial<KeyboardEventInit> = {}) => act(() => handleKey(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...more })))

  it('every editing key does nothing; Space plays and the arrows step', () => {
    open()
    S().select(['v1'])
    S().setPlayhead(2)
    const before = S().project
    key('b', { ctrlKey: true })
    key('Delete')
    key('Backspace', { shiftKey: true })
    key('d', { ctrlKey: true })
    key('c', { ctrlKey: true })
    key('v', { ctrlKey: true })
    key('x', { ctrlKey: true })
    key('l', { ctrlKey: true })
    key('S', { ctrlKey: true, shiftKey: true })
    key('m')
    key('z', { ctrlKey: true })
    expect(S().project).toBe(before)
    key(' ')
    expect(S().playing).toBe(true)
    key('ArrowRight')
    expect(S().playhead).toBeGreaterThan(2)
  })
})

describe('the timeline', () => {
  const clipEl = (id: string) => document.querySelector(`.tl-clip[data-item="${id}"]`) as HTMLElement
  function drag(el: Element, dx: number) {
    fireEvent.pointerDown(el, { button: 0, clientX: 500, clientY: 50 })
    fireEvent.pointerMove(window, { clientX: 500 + dx / 2, clientY: 50 })
    fireEvent.pointerMove(window, { clientX: 500 + dx, clientY: 50 })
    fireEvent.pointerUp(window, { clientX: 500 + dx, clientY: 50 })
  }

  it('a clip drag selects it and moves nothing; trims change nothing; keys on a focused clip change nothing', () => {
    open()
    render(<Timeline />)
    act(() => S().set({ zoom: 80 }))
    const before = S().project
    drag(clipEl('v1'), 160)
    expect(S().selection).toEqual(['v1'])
    expect(document.querySelector('.tl-ghost, .tl-drag-ghost')).toBeNull()
    drag(clipEl('v1').querySelector('.tl-trim.r')!, -160)
    fireEvent.keyDown(clipEl('v1'), { key: 'ArrowRight', altKey: true })
    fireEvent.keyDown(clipEl('v1'), { key: 'Delete' })
    expect(S().project).toBe(before)
  })

  it('the toolbar, track headers and context menu are disabled with the viewer tooltip; play still works', () => {
    open()
    render(<Timeline />)
    act(() => S().select(['v1']))
    for (const name of [/^Split/, /^Duplicate/, /^Separate audio/]) expect((screen.getByRole('button', { name }) as HTMLButtonElement).matches(':disabled')).toBe(true)
    const lock = screen.getAllByRole('button', { name: /^Lock / })[0]
    expect(lock.matches(':disabled')).toBe(true)
    expect(lock.closest('[data-ro-tip]')?.getAttribute('data-ro-tip')).toBe(TIP)
    expect(screen.getAllByRole('button', { name: /^Mute / })[0].matches(':disabled')).toBe(true)
    const play = screen.getByRole('button', { name: 'Play (Space)' })
    expect(play.matches(':disabled')).toBe(false)
    fireEvent.click(play)
    expect(S().playing).toBe(true)
    // the clip's menu: every item disabled, and choosing one does nothing
    fireEvent.contextMenu(clipEl('v1'), { clientX: 200, clientY: 100 })
    const menu = screen.getByRole('menu', { name: 'Clip' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.length).toBeGreaterThan(4)
    for (const it of items) expect(it.matches(':disabled')).toBe(true)
  })

  it('a marker jumps when clicked but doesn’t move, rename or delete', () => {
    open()
    render(<Timeline />)
    act(() => S().set({ zoom: 80 }))
    const m = screen.getByRole('button', { name: /Beat marker/ })
    const before = S().project
    drag(m, 120)
    expect(S().playhead).toBeCloseTo(4)
    fireEvent.doubleClick(m)
    expect(document.querySelector('.tl-marker-input')).toBeNull()
    fireEvent.keyDown(m, { key: 'F2' })
    expect(document.querySelector('.tl-marker-input')).toBeNull()
    fireEvent.keyDown(m, { key: 'Delete' })
    fireEvent.contextMenu(m, { clientX: 100, clientY: 20 })
    for (const it of within(screen.getByRole('menu', { name: 'Marker' })).getAllByRole('menuitem')) expect(it.matches(':disabled')).toBe(true)
    expect(S().project).toBe(before)
  })

  it('nothing dropped on the timeline lands there', () => {
    open()
    render(<Timeline />)
    const rows = document.querySelector('.tl-rows, .tl-body, [data-tl-rows]') ?? clipEl('v1').parentElement!
    const before = S().project
    fireEvent.drop(rows, { dataTransfer: { files: [new File(['x'], 'a.mp4', { type: 'video/mp4' })], types: ['Files'] } })
    expect(S().project).toBe(before)
  })
})

describe('the canvas', () => {
  it('a drag selects the object and moves nothing; a double click doesn’t open text editing; arrows don’t nudge', () => {
    open()
    render(<Canvas />)
    const before = S().project
    under = 's1'
    fireEvent.pointerDown(document.querySelector('.cv-stage [data-ps-layer="s1"]')!, { button: 0, clientX: 500, clientY: 300 })
    fireEvent.pointerMove(window, { clientX: 600, clientY: 340 })
    fireEvent.pointerUp(window, { clientX: 600, clientY: 340 })
    expect(S().selection).toEqual(['s1'])
    fireEvent.keyDown(document.querySelector('[data-canvas]')!, { key: 'ArrowLeft' })
    under = 't1'
    fireEvent.doubleClick(document.querySelector('[data-canvas]')!, { clientX: 960, clientY: 540 })
    expect(S().editingTextId).toBeNull()
    expect(S().project).toBe(before)
  })
})

describe('panels', () => {
  it('the properties panel shows every setting, disabled, while its tabs still switch', () => {
    open()
    S().select(['s1'])
    render(<PropertiesPanel />)
    const sliders = screen.getAllByRole('slider') as HTMLInputElement[]
    expect(sliders.length).toBeGreaterThan(0)
    for (const el of sliders) expect(el.matches(':disabled')).toBe(true)
    const tab = screen.getByRole('button', { name: 'Animation' })
    expect(tab.matches(':disabled')).toBe(false)
    fireEvent.click(tab)
    expect(S().activeRightTab).toBe('animation')
  })

  it('the left panels (captions, transcript, AI) are disabled; the transcript still seeks', () => {
    open()
    S().select(['v1'])
    S().set({ activeLeftTab: 'transcript', leftCollapsed: false })
    const { rerender } = render(<AssetPanel />)
    const word = screen.getByText('two')
    fireEvent.mouseDown(word)
    fireEvent.click(word)
    for (const b of screen.getAllByRole('button')) if (b.closest('.ed-panelbody')) expect(b.matches(':disabled')).toBe(true)
    act(() => S().set({ activeLeftTab: 'ai' }))
    rerender(<AssetPanel />)
    expect((screen.getByPlaceholderText(/Split at the playhead/) as HTMLTextAreaElement).matches(':disabled')).toBe(true)
    act(() => S().set({ activeLeftTab: 'captions' }))
    rerender(<AssetPanel />)
    const caps = screen.getAllByRole('button').filter((b) => b.closest('.ed-panelbody'))
    expect(caps.length).toBeGreaterThan(0)
    for (const b of caps) expect(b.matches(':disabled')).toBe(true)
  })

  it('an assistant answer that comes back after the role was lowered changes nothing', async () => {
    open('editor')
    let resolve!: (r: AssistantResult) => void
    vi.spyOn(api, 'assistant').mockReturnValueOnce(new Promise<AssistantResult>((r) => (resolve = r)))
    render(<AssistantPanel />)
    fireEvent.change(screen.getByPlaceholderText(/Split at the playhead/), { target: { value: 'Rename it' } })
    await act(async () => fireEvent.submit(screen.getByPlaceholderText(/Split at the playhead/).closest('form')!))
    act(() => useSession.setState({ workspaces: [space('viewer')] }))
    const before = S().project
    await act(async () => resolve({ text: 'Done', project: { ...before, name: 'Renamed by AI' }, changes: ['Renamed'] }))
    expect(S().project.name).toBe('Cut')
  })
})

describe('the top bar', () => {
  it('shows View only; the name, undo, ratio, share and export are closed to a viewer with the tooltip', () => {
    open()
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    )
    expect(screen.getByRole('status').textContent).toMatch(/View only/)
    const name = screen.getByRole('textbox', { name: 'Project name' }) as HTMLInputElement
    expect(name.readOnly).toBe(true)
    for (const label of [/^Undo|Nothing to undo/, /^Export/, /^Aspect ratio/]) {
      const b = screen.getByRole('button', { name: label })
      expect(b.matches(':disabled')).toBe(true)
      expect(b.getAttribute('data-tip')).toBe(TIP)
    }
    // looking around still works
    expect(screen.getByRole('button', { name: /Keyboard shortcuts/ }).matches(':disabled')).toBe(false)
  })

  it('an editor sees none of it', () => {
    open('editor')
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    )
    expect(screen.queryByText('View only')).toBeNull()
    expect(screen.getByRole('button', { name: /^Export/ }).matches(':disabled')).toBe(false)
  })
})

describe('uploads and the tooltip', () => {
  it('a viewer’s files are not uploaded', async () => {
    open()
    const spy = vi.spyOn(api, 'upload')
    await uploadFiles([new File(['x'], 'a.mp4', { type: 'video/mp4' })])
    expect(spy).not.toHaveBeenCalled()
    expect(useLibrary.getState().uploads).toHaveLength(0)
    expect(toasts()).toContain(TIP)
  })

  it('hovering a disabled control shows its name and who can use it', () => {
    vi.useFakeTimers()
    open()
    render(
      <>
        <TooltipLayer />
        <Timeline />
      </>,
    )
    fireEvent.pointerOver(screen.getByRole('button', { name: /^Split/ }))
    act(() => void vi.advanceTimersByTime(400))
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain('Split')
    expect(tip.textContent).toContain(TIP)
  })
})

it('an editor opening the same project edits as before', () => {
  open('editor')
  S().commit({ ...S().project, name: 'Edited' }, 'Rename')
  expect(S().project.name).toBe('Edited')
  expect(S().saveState).toBe('dirty')
  expect(findItem(S().project, 'v1')).toBeTruthy()
})
