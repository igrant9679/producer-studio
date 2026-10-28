// Sound on the timeline: track volume, solo and ducking in the track header (E-14), the volume rubber band and fade
// handles on a clip (E-15), J and L cuts with Shift on an audio edge (E-13), and the export's loudness target (E-14).
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addAsset, addItem, createAudioItem, createProject, createVideoItem, findItem, mainTrack, separateAudio, type AudioItem, type Asset, type ExportResult, type Job, type Project, type User, type Workspace } from '@producer/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { ExportDialog } from '../Dialogs'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'

const S = () => useEditor.getState()
const video = (id: string, duration = 30): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration, width: 1920, height: 1080, hasAudio: true })

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})
beforeEach(() => useSession.setState({ status: 'ready', user: undefined, workspaces: [], workspaceId: undefined } as never))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function load(p: Project) {
  S().load({ project: p, version: 1, projectId: 'p1', demo: true })
}

function show(zoom = 80) {
  const r = render(<Timeline />)
  act(() => useEditor.setState({ zoom }))
  return r
}

/** A video at 0..10 with music under it, 2..8 s. */
function withMusic(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, video('a'))
  p = addAsset(p, { id: 'm', kind: 'audio', name: 'm.mp3', src: '/api/media/m/source', duration: 60 })
  p = addItem(p, createVideoItem(p.assets.a, 0, { duration: 10 }))
  return addItem(p, createAudioItem(p.assets.m, 2, { duration: 6, name: 'Music' }))
}

const musicTrack = () => S().project.tracks.find((t) => t.kind === 'audio')!
const music = () => musicTrack().items[0] as AudioItem

describe('track sound: volume, solo, ducking (E-14)', () => {
  it('opens from the track header, keeps focus inside, and Escape returns it to the button', () => {
    load(withMusic())
    show()
    const btn = screen.getByRole('button', { name: 'Sound of Audio' })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(btn)
    const dialog = screen.getByRole('dialog', { name: 'Sound of Audio' })
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(dialog.contains(document.activeElement)).toBe(true)
    // Tab goes round the popover's controls instead of leaving it
    const stops = dialog.querySelectorAll('input')
    act(() => (stops[stops.length - 1] as HTMLElement).focus())
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Sound of Audio' })).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('sets the track volume, solo and ducking, each one undo step', () => {
    load(withMusic())
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Sound of Audio' }))
    const dialog = screen.getByRole('dialog', { name: 'Sound of Audio' })
    fireEvent.change(within(dialog).getByRole('slider', { name: 'Volume' }), { target: { value: '0.5' } })
    expect(musicTrack().volume).toBe(0.5)
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Solo' }))
    expect(musicTrack().solo).toBe(true)
    // the button says the track is soloed; the video track's says it's silenced
    expect(screen.getByRole('button', { name: 'Sound of Audio' }).className).toContain('solo')
    expect(screen.getByRole('button', { name: 'Sound of Main' }).className).toContain('off')
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Duck under voice' }))
    expect(musicTrack().duck).toBe(12)
    fireEvent.change(within(dialog).getByRole('slider', { name: 'Duck by' }), { target: { value: '18' } })
    expect(musicTrack().duck).toBe(18)
    act(() => S().undo())
    expect(musicTrack().duck).toBe(12)
  })

  it('caption and text tracks have no sound button', () => {
    let p = withMusic()
    p = addItem(p, { id: 'c', type: 'caption', start: 0, duration: 1, text: 'hi' })
    load(p)
    show()
    expect(screen.getAllByRole('button', { name: /^Sound of / })).toHaveLength(2)
  })

  it('a viewer sees the button disabled, saying who can change it', () => {
    const me = { id: 'u', email: 'v@example.com', name: 'Vi', avatarColor: '#fff', createdAt: 0 } as User
    const ws = { id: 'w', name: 'Client review', role: 'viewer', personal: false, memberCount: 2 } as Workspace
    useSession.setState({ status: 'ready', user: me, workspaces: [ws], workspaceId: ws.id } as never)
    load(withMusic())
    show()
    const btn = screen.getByRole('button', { name: 'Sound of Audio' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toMatch(/viewer/)
    // and no rubber band handles on a selected clip
    act(() => S().select([music().id]))
    expect(screen.queryByRole('slider', { name: 'Volume of Music' })).toBeNull()
  })
})

describe('volume rubber band and fade handles (E-15)', () => {
  it('appear on a selected clip with sound, as sliders', () => {
    load(withMusic())
    show()
    expect(screen.queryByRole('slider', { name: 'Volume of Music' })).toBeNull()
    act(() => S().select([music().id]))
    expect(screen.getByRole('slider', { name: 'Volume of Music' }).tabIndex).toBe(0)
    expect(screen.getByRole('slider', { name: 'Fade in of Music' })).toBeTruthy()
    expect(screen.getByRole('slider', { name: 'Fade out of Music' })).toBeTruthy()
  })

  it('by keyboard: arrows raise the line, Enter adds a keyframe at the playhead, which moves and deletes', () => {
    load(withMusic())
    show()
    act(() => S().select([music().id]))
    const line = screen.getByRole('slider', { name: 'Volume of Music' })
    fireEvent.keyDown(line, { key: 'ArrowUp' })
    fireEvent.keyDown(line, { key: 'ArrowUp', shiftKey: true })
    expect(music().volume).toBeCloseTo(1.11, 4)
    act(() => S().setPlayhead(5))
    fireEvent.keyDown(line, { key: 'Enter' })
    expect(music().keyframes.volume).toEqual([{ t: 3, value: 1.11 }])
    const kf = screen.getByRole('slider', { name: 'Volume keyframe 1 of Music' })
    expect(kf.getAttribute('aria-valuetext')).toBe('111 % at 3.00 s')
    fireEvent.keyDown(kf, { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(kf, { key: 'ArrowRight', shiftKey: true })
    expect(music().keyframes.volume![0].value).toBeCloseTo(1.01, 4)
    expect(music().keyframes.volume![0].t).toBeCloseTo(3.5, 4)
    // with keyframes, the line moves them all
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Volume of Music' }), { key: 'ArrowDown', shiftKey: true })
    expect(music().keyframes.volume![0].value).toBeCloseTo(0.91, 4)
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Volume keyframe 1 of Music' }), { key: 'Delete' })
    expect(music().keyframes.volume).toBeUndefined()
    expect(document.activeElement).toBe(screen.getByRole('slider', { name: 'Volume of Music' }))
    // the clip is still there: Delete on a keyframe removed only the keyframe
    expect(findItem(S().project, music().id)).not.toBeNull()
  })

  it('fade handles drag and step, inside half the clip', () => {
    load(withMusic())
    show(80)
    act(() => S().select([music().id]))
    const fin = screen.getByRole('slider', { name: 'Fade in of Music' })
    fireEvent.pointerDown(fin, { button: 0, clientX: 100, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 140, clientY: 10 })
    fireEvent.pointerUp(window, { clientX: 140, clientY: 10 })
    expect(music().fadeIn).toBe(0.5)
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Fade in of Music' }), { key: 'ArrowRight' })
    expect(music().fadeIn).toBe(0.55)
    // a fade out handle moves left to lengthen; End is the longest fade (half the 6 s clip)
    const fout = screen.getByRole('slider', { name: 'Fade out of Music' })
    fireEvent.pointerDown(fout, { button: 0, clientX: 500, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 420, clientY: 10 })
    fireEvent.pointerUp(window, { clientX: 420, clientY: 10 })
    expect(music().fadeOut).toBe(1)
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Fade out of Music' }), { key: 'End' })
    expect(music().fadeOut).toBe(3)
    // the drag was one undo step
    act(() => S().undo())
    expect(music().fadeOut).toBe(1)
  })

  it('dragging the line changes the level; double-clicking it adds a keyframe; double-clicking that removes it', () => {
    load(withMusic())
    show(80)
    act(() => S().select([music().id]))
    const clip = document.querySelector(`.tl-clip[data-item="${music().id}"]`) as HTMLElement
    const hit = clip.querySelector('.tl-vband-hit')!
    fireEvent.pointerDown(hit, { button: 0, clientX: 100, clientY: 40 })
    fireEvent.pointerMove(window, { clientX: 100, clientY: 20 })
    fireEvent.pointerUp(window, { clientX: 100, clientY: 20 })
    expect(music().volume).toBeGreaterThan(1)
    const raised = music().volume
    // jsdom lays nothing out: the band's left edge is at 0, so clientX is the time × zoom
    fireEvent.doubleClick(hit, { clientX: 160 })
    expect(music().keyframes.volume).toEqual([{ t: 2, value: raised }])
    expect(music().start).toBe(2)
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'Volume keyframe 1 of Music' }))
    expect(music().keyframes.volume).toBeUndefined()
  })

  it('no band on a muted video, a locked clip, or a clip without sound', () => {
    let p = withMusic()
    const v = mainTrack(p)!.items[0].id
    p = separateAudio(p, v)
    load(p)
    show()
    act(() => S().select([v]))
    expect(screen.queryByRole('slider', { name: /^Volume of / })).toBeNull()
    act(() => S().select([music().id]))
    expect(screen.getByRole('slider', { name: 'Volume of Music' })).toBeTruthy()
    act(() => S().commit({ ...S().project, tracks: S().project.tracks.map((t) => (t.kind === 'audio' ? { ...t, locked: true } : t)) }, 'Lock'))
    expect(screen.queryByRole('slider', { name: 'Volume of Music' })).toBeNull()
  })
})

describe('J and L cuts from the timeline (E-13)', () => {
  /** Two 10 s clips, each with its sound separated onto one audio track. */
  function pair() {
    let p = createProject({ id: 'p1' })
    p = addAsset(p, video('x'))
    p = addAsset(p, video('y'))
    p = addItem(p, createVideoItem(p.assets.x, 0, { duration: 10, in: 5 }))
    p = addItem(p, createVideoItem(p.assets.y, 99, { duration: 10, in: 5 }))
    const [va, vb] = mainTrack(p)!.items.map((i) => i.id)
    p = separateAudio(separateAudio(p, va), vb)
    const [aa, ab] = p.tracks.find((t) => t.kind === 'audio')!.items.map((i) => i.id)
    return { p, vb, aa, ab }
  }
  const item = (id: string) => findItem(S().project, id)!.item

  it('Shift+drag on an audio edge moves only the sound, rolling the one before', () => {
    const { p, vb, aa, ab } = pair()
    load(p)
    show(80)
    const handle = document.querySelector(`.tl-clip[data-item="${ab}"] .tl-trim.l`)!
    fireEvent.pointerDown(handle, { button: 0, clientX: 800, clientY: 50 })
    fireEvent.pointerMove(window, { clientX: 680, clientY: 50, shiftKey: true })
    fireEvent.pointerUp(window, { clientX: 680, clientY: 50, shiftKey: true })
    expect(item(ab)).toMatchObject({ start: 8.5, in: 3.5 })
    expect(item(aa)).toMatchObject({ duration: 8.5 })
    expect(item(vb)).toMatchObject({ start: 10, in: 5 })
  })

  it('Shift+] on a focused audio clip makes an L cut to the playhead', () => {
    const { p, aa, ab } = pair()
    load(p)
    show(80)
    act(() => S().select([aa]))
    const cell = document.querySelector(`[data-item="${aa}"]`) as HTMLElement
    act(() => cell.focus())
    act(() => S().setPlayhead(12))
    fireEvent.keyDown(cell, { key: '}', shiftKey: true })
    expect(item(aa)).toMatchObject({ duration: 12 })
    expect(item(ab)).toMatchObject({ start: 12, in: 7 })
  })
})

describe('loudness on export (E-14)', () => {
  const doneJob = { id: 'j1', kind: 'export.render', status: 'done', progress: 1, message: 'Done', result: { exportId: 'e1', url: '/x.mp4', sizeBytes: 1000, duration: 1 } } as unknown as Job<ExportResult>

  it('asks for the chosen target, and offers none for a GIF', async () => {
    S().load({ project: withMusic(), version: 3, projectId: 'p1', demo: false, workspaceId: 'w1' })
    vi.spyOn(api, 'exports').mockResolvedValue([])
    vi.spyOn(api, 'job').mockResolvedValue(doneJob as never)
    vi.spyOn(api, 'saveProject').mockResolvedValue({ version: 4, updatedAt: 1 } as never)
    const exp = vi.spyOn(api, 'exportProject').mockResolvedValue({ ...doneJob, status: 'queued' } as never)
    render(<ExportDialog />)
    // a GIF has no sound to even out; the dialog shows its progress once an export starts, so check it first
    fireEvent.click(screen.getByRole('button', { name: /GIF/ }))
    expect(screen.queryByRole('button', { name: /^Podcast/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^MP4/ }))
    const podcast = screen.getByRole('button', { name: /^Podcast −16 LUFS/ })
    fireEvent.click(podcast)
    expect(podcast.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/evened out to -16 LUFS/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Export$/ }))
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(exp.mock.calls[0][1]).toMatchObject({ loudness: 'podcast', format: 'mp4' })
  }, 20_000)
})
