// Smart tools (E-21): masks edited in the Smart tab and with handles on the canvas, drawing a path mask, the chroma
// key and its eyedropper, and the server tools whose processed copy is swapped in as one undo step.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  addAsset,
  addItem,
  createProject,
  createTextItem,
  createVideoItem,
  findItem,
  separateAudio,
  type Asset,
  type AudioItem,
  type Job,
  type Project,
  type SmartJobResult,
  type SmartToolsInfo,
  type User,
  type VideoItem,
  type Workspace,
} from '@producer/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useToasts } from '../../lib/toast'
import { Canvas } from '../Canvas'
import { useCanvasView } from '../canvasView'
import { PropertiesPanel } from '../PropertiesPanel'
import { useSmart } from '../smartActions'
import { useEditor } from '../store'
import { useLibrary } from '../uploads'

const S = () => useEditor.getState()

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})

const video = (id: string, duration = 20, over: Partial<Asset> = {}): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/demo/${id}.mp4`, duration, width: 1920, height: 1080, hasAudio: true, ...over })

const TOOLS: SmartToolsInfo = {
  stabilise: { method: 'vidstab' },
  denoise: { audio: ['afftdn'], video: ['hqdn3d', 'nlmeans'] },
  removeBackground: { available: false },
  why: { removeBackground: 'Background removal is not set up on this server: the owner sets BG_REMOVAL_CMD to a removal tool installed there.' },
}

/** One 1920 × 1080 clip filling the canvas from 0 to 8 s, its source from 4 s; a title. */
function project(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, video('a'))
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va', duration: 8, in: 4 }))
  p = addItem(p, createTextItem(0, 'title-serif', { id: 'tt', text: 'Hi', duration: 3 }))
  return p
}

const clip = (id = 'va') => findItem(S().project, id)!.item as VideoItem
const lastLabel = () => S().history.past.at(-1)?.label

beforeEach(() => {
  localStorage.clear()
  useSession.setState({ status: 'ready', user: undefined, workspaces: [], workspaceId: undefined } as never)
  useCanvasView.setState({ rulers: false, safeZone: null, guides: { v: [], h: [] }, projectId: '' })
  useSmart.setState({ tools: TOOLS, toolsError: undefined, maskEdit: null, drawing: null, picking: null, running: {} })
  useToasts.setState({ toasts: [] })
  useLibrary.setState({ records: [] })
  S().load({ project: project(), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  S().set({ canvasZoom: 1 })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The Smart tab of the selected clip, with the canvas beside it. */
function open(id = 'va', withCanvas = true) {
  act(() => S().select([id]))
  const r = render(
    <>
      {withCanvas && <Canvas />}
      <PropertiesPanel />
    </>,
  )
  fireEvent.click(screen.getByRole('tab', { name: 'Smart' }))
  return r
}

/** Drag on the canvas at zoom 1 (screen px are canvas px: the canvas box sits at 0,0 in jsdom). */
function drag(el: Element, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(el, { button: 0, clientX: from[0], clientY: from[1] })
  fireEvent.pointerMove(window, { clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 })
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1] })
  fireEvent.pointerUp(window)
}

const handle = (name: string) => document.querySelector(`[data-mask-handles] [data-handle="${name}"]`)!
const toasts = () => useToasts.getState().toasts.map((t) => t.text)

describe('the Smart tab', () => {
  it('is there for videos, pictures and sounds, not for text', () => {
    open('va', false)
    expect(screen.getByRole('tab', { name: 'Smart' })).toBeTruthy()
    cleanup()
    act(() => S().select(['tt']))
    render(<PropertiesPanel />)
    expect(screen.queryByRole('tab', { name: 'Smart' })).toBeNull()
  })

  it('a viewer sees every control disabled, saying who can change it', () => {
    const me = { id: 'u', email: 'v@example.com', name: 'Vi', avatarColor: '#fff', createdAt: 0 } as User
    const ws = { id: 'w1', name: 'Client review', role: 'viewer', personal: false, memberCount: 2 } as Workspace
    useSession.setState({ status: 'ready', user: me, workspaces: [ws], workspaceId: ws.id } as never)
    open('va', false)
    expect(screen.getByRole('note').textContent).toMatch(/You’re a viewer/)
    expect((screen.getByRole('button', { name: 'Rectangle mask' }) as HTMLButtonElement).matches(':disabled')).toBe(true)
    expect((screen.getByRole('button', { name: 'Stabilise' }) as HTMLButtonElement).matches(':disabled')).toBe(true)
  })
})

describe('masks', () => {
  it('adds a rectangle, edits it by keyboard with keyframes, inverts it and takes it off, each one undo step', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Rectangle mask' }))
    expect(clip().mask).toMatchObject({ shape: 'rect', width: 0.6 })
    expect(lastLabel()).toBe('Add mask')
    // its handles come up on the canvas with it
    expect(handle('se')).toBeTruthy()
    // the number fields set it in per cent of the frame
    const width = screen.getByRole('textbox', { name: 'Mask width value' })
    fireEvent.focus(width)
    fireEvent.change(width, { target: { value: '40' } })
    fireEvent.keyDown(width, { key: 'Enter' })
    fireEvent.blur(width)
    expect(clip().mask!.width).toBe(0.4)
    // ◇ beside Mask X: a keyframe at the playhead, then moving the playhead and changing X adds a second
    const row = screen.getByText('Mask X').closest('.ed-field') as HTMLElement
    fireEvent.click(within(row).getByTitle(/Add keyframe/))
    expect(clip().keyframes.maskX).toEqual([{ t: 0, value: 0.5, ease: 'easeInOut' }])
    act(() => S().setPlayhead(2))
    const x = screen.getByRole('textbox', { name: 'Mask X value' })
    fireEvent.focus(x)
    fireEvent.change(x, { target: { value: '25' } })
    fireEvent.blur(x)
    expect(clip().keyframes.maskX!.map((k) => [k.t, k.value])).toEqual([[0, 0.5], [2, 0.25]])
    // the Keyframes section lists the mask's lane
    expect(screen.getByRole('button', { name: /Mask X keyframe at 2\.00 s, 25%/ })).toBeTruthy()
    fireEvent.click(within(screen.getByText('Invert').closest('.ed-field') as HTMLElement).getByRole('switch'))
    expect(clip().mask!.invert).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'No mask' }))
    expect(clip().mask).toBeUndefined()
    expect(clip().keyframes.maskX).toBeUndefined()
    act(() => S().undo())
    expect(clip().mask!.invert).toBe(true)
  })

  it('moves, resizes and rotates the mask with its handles on the canvas', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Ellipse mask' }))
    // the clip fills the 1920 × 1080 canvas; the mask is centred, 60 % of it
    const outline = document.querySelector('[data-mask-handles] .cv-mask-outline')!
    drag(outline, [960, 540], [1152, 432])
    expect(clip().mask).toMatchObject({ x: 0.6, y: 0.4 })
    expect(lastLabel()).toBe('Move mask')
    const before = S().history.past.length
    // the bottom-right corner: half the size each way is the distance from the centre
    drag(handle('se'), [1152 + 576, 432 + 324], [1152 + 384, 432 + 216])
    expect(clip().mask).toMatchObject({ width: 0.4, height: 0.4 })
    // a drag is one undo step
    expect(S().history.past.length).toBe(before + 1)
    // the side handle changes the width only
    drag(handle('e'), [1152 + 384, 432], [1152 + 96, 432])
    expect(clip().mask).toMatchObject({ width: 0.1, height: 0.4 })
    // the rotate handle: straight to the right of the centre is a quarter turn
    drag(handle('rotate'), [1152, 432 - 216 - 22], [1400, 432])
    expect(clip().mask!.rotation).toBe(90)
    // Escape ends editing; the handles go
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('[data-mask-handles]')).toBeNull()
    expect(useSmart.getState().maskEdit).toBeNull()
  })

  it('draws a path mask corner by corner; Backspace takes one back without deleting the clip', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Drawn mask' }))
    const layer = document.querySelector('[data-smart-overlay]')!
    const click = (x: number, y: number) => fireEvent.pointerDown(layer, { button: 0, clientX: x, clientY: y })
    click(192, 108)
    click(1536, 108)
    click(960, 900)
    click(600, 600)
    fireEvent.keyDown(window, { key: 'Backspace' })
    expect(useSmart.getState().drawing!.points).toHaveLength(3)
    expect(findItem(S().project, 'va')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Enter' })
    const m = clip().mask!
    expect(m.shape).toBe('path')
    expect(m.points).toHaveLength(3)
    expect(m).toMatchObject({ x: 0.45, width: 0.7 })
    expect(lastLabel()).toBe('Draw mask')
    // its corners have handles: dragging one moves that corner only
    expect(handle('point-2')).toBeTruthy()
    // Escape while drawing again keeps the mask as it was
    fireEvent.click(screen.getByRole('button', { name: /Draw again/ }))
    click(100, 100)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useSmart.getState().drawing).toBeNull()
    expect(clip().mask!.points).toHaveLength(3)
  })

  it('needs three corners to close a drawn mask', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Drawn mask' }))
    fireEvent.pointerDown(document.querySelector('[data-smart-overlay]')!, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(clip().mask).toBeUndefined()
    expect(toasts().at(-1)).toMatch(/at least three points/)
  })
})

describe('chroma key', () => {
  it('turns on, takes a preset colour and its sliders, and the eyedropper reads the picture', () => {
    open()
    fireEvent.click(within(screen.getByText('Key out a colour').closest('.ed-field') as HTMLElement).getByRole('switch'))
    expect(clip().chromaKey).toMatchObject({ color: '#00b140', tolerance: 35 })
    fireEvent.click(screen.getByRole('button', { name: /Blue screen/ }))
    expect(clip().chromaKey!.color).toBe('#0047bb')
    const tol = screen.getByRole('slider', { name: 'Tolerance' })
    fireEvent.change(tol, { target: { value: '60' } })
    expect(clip().chromaKey!.tolerance).toBe(60)
    // the eyedropper: the frame under the pointer, read from the clip's own picture
    const v = document.querySelector('.cv-stage [data-ps-layer="va"] [data-ps-content]') as HTMLVideoElement
    Object.defineProperty(v, 'videoWidth', { value: 1920 })
    Object.defineProperty(v, 'videoHeight', { value: 1080 })
    const drawn: number[][] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: (_img: unknown, ...a: number[]) => drawn.push(a),
      getImageData: () => ({ data: new Uint8ClampedArray(Array.from({ length: 25 }, () => [10, 250, 20, 255]).flat()) }),
    } as never)
    fireEvent.click(screen.getByRole('button', { name: 'Pick from the picture' }))
    expect(useSmart.getState().picking).toBe('va')
    fireEvent.pointerDown(document.querySelector('[data-smart-overlay]')!, { button: 0, clientX: 480, clientY: 270 })
    expect(clip().chromaKey!.color).toBe('#0afa14')
    expect(lastLabel()).toBe('Pick key colour')
    expect(drawn[0].slice(0, 2)).toEqual([480 - 2.5, 270 - 2.5])
    expect(useSmart.getState().picking).toBeNull()
  })

  it('says so when the picture can’t be read yet', () => {
    open()
    fireEvent.click(within(screen.getByText('Key out a colour').closest('.ed-field') as HTMLElement).getByRole('switch'))
    fireEvent.click(screen.getByRole('button', { name: 'Pick from the picture' }))
    fireEvent.pointerDown(document.querySelector('[data-smart-overlay]')!, { button: 0, clientX: 480, clientY: 270 })
    expect(toasts().at(-1)).toMatch(/Couldn’t read the colour/)
    expect(clip().chromaKey!.color).toBe('#00b140')
  })
})

describe('clean-up tools', () => {
  function mockJob(result: Partial<SmartJobResult>) {
    const call = vi.spyOn(api, 'smartTool').mockResolvedValue({ id: 'j1', status: 'queued', progress: 0, message: 'Queued' } as never)
    let calls = 0
    vi.spyOn(api, 'job').mockImplementation(async () => {
      calls++
      if (calls === 1) return { id: 'j1', status: 'running', progress: 0.4, message: 'Steadying the picture' } as unknown as Job as never
      return { id: 'j1', status: 'done', progress: 1, result } as unknown as Job as never
    })
    return call
  }
  const copy = (id: string, over: Partial<Asset> = {}) => ({ asset: video(id, 10, { name: `${id}.mp4`, ...over }), status: 'ready', workspaceId: 'w1', origin: 'smart', createdAt: 0 })

  it('lists what the server can do and says why a tool is off', () => {
    open('va', false)
    const btn = screen.getByRole('button', { name: 'Remove background' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(document.getElementById(btn.getAttribute('aria-describedby')!)!.textContent).toMatch(/not set up on this server/)
    expect((screen.getByRole('button', { name: 'Stabilise' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('stabilises the part the clip uses and swaps the copy in, in one undo step', async () => {
    const call = mockJob({ tool: 'stabilise', asset: copy('stab') as never, offset: 3, sourceAssetId: 'a' })
    open('va', false)
    fireEvent.click(screen.getByRole('button', { name: 'Stabilise' }))
    // the clip shows 4..12 s of its file: a second either side
    expect(call).toHaveBeenCalledWith('a', 'stabilise', { from: 3, to: 13, smoothing: 50 })
    await waitFor(() => expect(screen.getByRole('status', { name: /Stabilise: 40%/ })).toBeTruthy(), { timeout: 3000 })
    await waitFor(() => expect(clip().assetId).toBe('stab'), { timeout: 4000 })
    expect(clip()).toMatchObject({ in: 1, duration: 8, start: 0 })
    expect(lastLabel()).toBe('Stabilise')
    expect(useLibrary.getState().records.map((r) => r.asset.id)).toContain('stab')
    expect(toasts().at(-1)).toMatch(/Stabilised\. Undo puts the original back/)
    act(() => S().undo())
    expect(clip()).toMatchObject({ assetId: 'a', in: 4 })
  })

  it("cleans a separated sound as a sound file; the picture keeps its file", async () => {
    act(() => S().commit(separateAudio(S().project, 'va'), 'Separate'))
    const sound = S().project.tracks.flatMap((t) => t.items).find((x) => x.type === 'audio') as AudioItem
    const call = mockJob({ tool: 'denoise', asset: copy('clean', { kind: 'audio' }) as never, offset: 0, sourceAssetId: 'a' })
    open(sound.id, false)
    expect(screen.queryByRole('button', { name: 'Stabilise' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clean up sound' }))
    expect(call).toHaveBeenCalledWith('a', 'denoise', { target: 'audio', strength: 50, soundOnly: true })
    await waitFor(() => expect((findItem(S().project, sound.id)!.item as AudioItem).assetId).toBe('clean'), { timeout: 4000 })
    // the picture keeps its file
    expect(clip().assetId).toBe('a')
  })

  it('keeps the copy in the library when the clip changed its media meanwhile', async () => {
    mockJob({ tool: 'denoise', asset: copy('clean2') as never, offset: 3, sourceAssetId: 'a' })
    open('va', false)
    fireEvent.click(screen.getByRole('button', { name: 'Clean up picture' }))
    act(() => S().commit({ ...S().project, tracks: S().project.tracks.map((t) => ({ ...t, items: t.items.map((x) => (x.id === 'va' ? { ...x, assetId: 'other' } : x)) })) } as Project, 'Replace media'))
    await waitFor(() => expect(toasts().at(-1)).toMatch(/changed meanwhile/), { timeout: 4000 })
    expect(clip().assetId).toBe('other')
    expect(useLibrary.getState().records.map((r) => r.asset.id)).toContain('clean2')
  })

  it('says what went wrong and clears the progress', async () => {
    vi.spyOn(api, 'smartTool').mockRejectedValue(new Error('This clip is still being processed'))
    open('va', false)
    fireEvent.click(screen.getByRole('button', { name: 'Stabilise' }))
    await waitFor(() => expect(toasts().at(-1)).toMatch(/still being processed/))
    expect(useSmart.getState().running).toEqual({})
    expect(clip().assetId).toBe('a')
  })
})
