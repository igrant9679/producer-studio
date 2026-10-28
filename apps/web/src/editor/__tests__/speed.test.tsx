// The Speed tab (E-17): speed ramp presets and the ramp curve by keyboard, the pitch toggle, smooth slow motion
// (started, shown on the clip while it is made, brought in when its job is done), and what a viewer sees.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, findItem, rampOf, setItemSpeed, sourceSpan, type Asset, type Job, type Project, type SmoothCopyResult, type VideoItem } from '@producer/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useToasts } from '../../lib/toast'
import { PropertiesPanel } from '../PropertiesPanel'
import { SmoothJobsHost } from '../SpeedPanel'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'

const S = () => useEditor.getState()
const video = (id: string, duration = 30): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration, width: 1920, height: 1080, fps: 30, hasAudio: true })
const clip = () => findItem(S().project, 'va')!.item as VideoItem

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})

function project(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, video('a'))
  return addItem(p, createVideoItem(p.assets.a, 0, { id: 'va', in: 2, duration: 8 }))
}

function open(p: Project = project()) {
  S().load({ project: p, version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  act(() => {
    S().select(['va'])
    useEditor.setState({ activeRightTab: 'speed', rightCollapsed: false })
  })
  render(
    <>
      <PropertiesPanel />
      <Timeline />
      <SmoothJobsHost />
    </>,
  )
}

beforeEach(() => {
  useSession.setState({ workspaces: [{ id: 'w1', name: 'Mine', role: 'owner', personal: true, memberCount: 1 }], workspaceId: 'w1' } as never)
  useToasts.setState({ toasts: [] })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('speed ramps in the Speed tab (E-17)', () => {
  it('a preset ramps the clip, keeps its stretch of the recording, and is one undo step', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Hero' }))
    expect(rampOf(clip())).toBeTruthy()
    expect(sourceSpan(clip())).toBeCloseTo(8, 3)
    expect(clip().duration).not.toBeCloseTo(8, 1)
    expect(screen.getByRole('button', { name: 'Hero' }).getAttribute('aria-pressed')).toBe('true')
    expect(S().history.past.at(-1)!.label).toBe('Speed ramp: Hero')
    // the clip on the timeline says it ramps
    expect(document.querySelector('.tl-clip[data-item="va"]')!.textContent).toContain('ramp')
    fireEvent.click(screen.getByRole('button', { name: 'None' }))
    expect(clip().speedRamp).toBeUndefined()
    act(() => S().undo())
    act(() => S().undo())
    expect(clip().duration).toBe(8)
  })

  it('the curve takes the keyboard: speeds up and down, points added and removed', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Ramp up' }))
    const start = screen.getByRole('slider', { name: 'Speed at the start' })
    expect(start.getAttribute('aria-valuetext')).toBe('0.5× at 0% of the clip')
    start.focus()
    fireEvent.keyDown(start, { key: 'ArrowUp', shiftKey: true })
    expect(Number(screen.getByRole('slider', { name: 'Speed at the start' }).getAttribute('aria-valuenow'))).toBeCloseTo(0.625, 3)
    // a changed preset is a ramp of its own
    expect(screen.getByRole('button', { name: 'Ramp up' }).getAttribute('aria-pressed')).toBe('false')
    // the ends stay at the ends
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Speed at the start' }), { key: 'ArrowRight' })
    expect(screen.getByRole('slider', { name: 'Speed at the start' }).getAttribute('aria-valuetext')).toMatch(/at 0% of the clip/)
    // a point in the middle (the playhead is at 0, so it goes half way), moved and removed by keys
    fireEvent.click(screen.getByRole('button', { name: /Add point/ }))
    const mid = screen.getByRole('slider', { name: 'Speed point 1 of 1' })
    expect(mid.getAttribute('aria-valuetext')).toMatch(/at 50% of the clip/)
    fireEvent.keyDown(mid, { key: 'ArrowRight', shiftKey: true })
    expect(screen.getByRole('slider', { name: 'Speed point 1 of 1' }).getAttribute('aria-valuetext')).toMatch(/at 55% of the clip/)
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Speed point 1 of 1' }), { key: 'Delete' })
    expect(screen.queryByRole('slider', { name: 'Speed point 1 of 1' })).toBeNull()
    expect(sourceSpan(clip())).toBeCloseTo(8, 3)
  })

  it('the pitch toggle keeps the pitch by default, and lets it follow the speed', () => {
    open()
    const keep = screen.getByRole('switch', { name: 'Keep pitch' }) as HTMLInputElement
    expect(keep.checked).toBe(true)
    fireEvent.click(keep)
    expect(clip().pitchShift).toBe(true)
    expect(screen.getByText(/faster sounds higher/)).toBeTruthy()
  })
})

describe('smooth slow motion (E-17)', () => {
  it('is made for a slowed clip, shows on the clip while it is made, and plays once its job is done', async () => {
    const copy: Asset = { ...video('sm1', 10), name: 'a · smooth 60 fps', fps: 60 }
    const start = vi.spyOn(api, 'smoothSlowMotion').mockResolvedValue({ id: 'jb_s', kind: 'media.smooth', status: 'queued', progress: 0, message: '', workspaceId: 'w1', createdAt: 0, updatedAt: 0 } as Job<SmoothCopyResult>)
    let done = false
    vi.spyOn(api, 'job').mockImplementation(async () => ({ id: 'jb_s', kind: 'media.smooth', status: done ? 'done' : 'running', progress: done ? 1 : 0.4, message: '', workspaceId: 'w1', createdAt: 0, updatedAt: 0, result: done ? { asset: copy, from: 1, to: 11, fps: 60 } : undefined }) as never)
    open(setItemSpeed(project(), 'va', 0.5))
    const make = screen.getByRole('button', { name: /Make smooth slow motion/ })
    fireEvent.click(make)
    await waitFor(() => expect(start).toHaveBeenCalledWith('a', { from: 1, to: 11, fps: 60, projectId: 'p1' }))
    await waitFor(() => expect(clip().smooth?.jobId).toBe('jb_s'))
    expect(screen.getByRole('status', { name: 'Making smooth slow motion' })).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/Making the in-between frames \(40%\)/)).toBeTruthy())
    done = true
    await waitFor(() => expect(clip().smooth?.assetId).toBe('sm1'), { timeout: 3000 })
    expect(S().project.assets.sm1).toBeTruthy()
    expect(screen.getByText(/Playing the smooth copy \(60 fps\)/)).toBeTruthy()
    // bringing it in is not an undo step of its own
    expect(S().history.past.at(-1)!.label).toBe('Smooth slow motion')
    fireEvent.click(screen.getByRole('button', { name: 'Use the original frames' }))
    expect(clip().smooth).toBeUndefined()
  })

  it('a failed job puts the clip back as it was and says so', async () => {
    vi.spyOn(api, 'smoothSlowMotion').mockResolvedValue({ id: 'jb_f', kind: 'media.smooth', status: 'queued' } as Job<SmoothCopyResult>)
    vi.spyOn(api, 'job').mockResolvedValue({ id: 'jb_f', kind: 'media.smooth', status: 'error', error: 'ffmpeg failed' } as never)
    open(setItemSpeed(project(), 'va', 0.5))
    fireEvent.click(screen.getByRole('button', { name: /Make smooth slow motion/ }))
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => /smooth slow motion/.test(t.text))).toBe(true))
    expect(clip().smooth).toBeUndefined()
  })

  it('is not offered at normal speed', () => {
    open()
    expect((screen.getByRole('button', { name: /Make smooth slow motion/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('a viewer (E-17)', () => {
  it('sees the speed settings but cannot change them', () => {
    useSession.setState({ workspaces: [{ id: 'w1', name: 'Client', role: 'viewer', personal: false, memberCount: 2 }], workspaceId: 'w1' } as never)
    open()
    expect(screen.getByRole('note').textContent).toMatch(/viewer/i)
    for (const name of ['Hero', 'None', 'Make smooth slow motion']) expect((screen.getByRole('button', { name: new RegExp(name) }) as HTMLButtonElement).closest('fieldset')!.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Hero' }))
    expect(rampOf(clip())).toBeNull()
    // the curve's points can be read but not moved
    const start = screen.getByRole('slider', { name: 'Speed at the start' })
    expect(start.getAttribute('aria-readonly')).toBe('true')
    fireEvent.keyDown(start, { key: 'ArrowUp' })
    expect(rampOf(clip())).toBeNull()
  })
})
