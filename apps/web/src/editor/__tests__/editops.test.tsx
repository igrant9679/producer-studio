// Edit actions and properties-panel edits from the phase 4 pass.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addAsset, addItem, createProject, createTextItem, createVideoItem, findItem, importSrt, mainTrack, setCanvasSize, setKeyframe, updateItem, type Asset, type Project, type TextItem, type VideoItem, type VisualItem } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useToasts } from '../../lib/toast'
import * as A from '../actions'
import { PropertiesPanel } from '../PropertiesPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()

const clip = (id: string, duration = 10): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration, width: 1920, height: 1080, hasAudio: true })

/** Main track: v1 0-10, v2 10-16. */
function project(): Project {
  let p = addAsset(addAsset(createProject({ id: 'p1', name: 'Ops' }), clip('as_a')), clip('as_b', 6))
  p = addItem(p, createVideoItem(p.assets.as_a, 0, { id: 'v1' }))
  return addItem(p, createVideoItem(p.assets.as_b, 99, { id: 'v2' }))
}

const load = (p: Project, workspaceId = 'w1', projectId = p.id) => S().load({ project: p, version: 1, projectId, demo: false, workspaceId })

beforeEach(() => {
  useToasts.setState({ toasts: [] })
  load(project())
})

afterEach(cleanup)

describe('copy and paste between projects (EDT-18)', () => {
  it('a clip pasted into another project brings its media record', () => {
    S().select(['v2'])
    A.copy()
    load(createProject({ id: 'p2', name: 'Other' }))
    A.paste()
    const p = S().project
    expect(p.assets.as_b).toEqual(project().assets.as_b)
    expect(mainTrack(p)!.items).toHaveLength(1)
  })

  it("clips copied in another space aren't pasted; the rest is", () => {
    const p = addItem(project(), createTextItem(0, 'heading', { id: 't1', duration: 2 }))
    load(p)
    S().select(['v2', 't1'])
    A.copy()
    load(createProject({ id: 'p3', name: 'Elsewhere' }), 'w2')
    A.paste()
    const items = S().project.tracks.flatMap((t) => t.items)
    expect(items.map((i) => i.type)).toEqual(['text'])
    expect(S().project.assets.as_b).toBeUndefined()
    expect(useToasts.getState().toasts.map((t) => t.text).join(' ')).toMatch(/another space/)
  })
})

describe('separate audio (EDT-21)', () => {
  it('a second Separate says the audio is already separated and adds nothing', () => {
    S().select(['v1'])
    A.separate()
    const once = S().project
    expect(once.tracks.filter((t) => t.kind === 'audio')).toHaveLength(1)
    A.separate()
    expect(S().project).toBe(once)
    expect(useToasts.getState().toasts.map((t) => t.text)).toContain("This clip's audio is already on its own track")
  })
})

describe('Speed tab (EDT-23)', () => {
  it('a speed chip rescales the clip, its keyframes and its fades', () => {
    load(setKeyframe(updateItem<VideoItem>(project(), 'v1', { fadeOut: 2 }), 'v1', 'opacity', 6, 0.3))
    S().select(['v1'])
    S().set({ activeRightTab: 'speed' })
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: '2×' }))
    const v = findItem(S().project, 'v1')!.item as VideoItem
    expect(v).toMatchObject({ speed: 2, duration: 5, fadeOut: 1 })
    expect(v.keyframes.opacity!.map((k) => k.t)).toEqual([3])
  })
})

describe('text and captions sized for the canvas (EDT-20)', () => {
  it('new text on a 4K canvas is twice the 1080p size', () => {
    load(setCanvasSize(project(), 3840, 2160))
    const id = A.addText('heading', 0)
    expect((findItem(S().project, id)!.item as TextItem).style.fontSize).toBe(240)
  })

  it('applying a caption preset keeps the canvas scaling', () => {
    const p = importSrt(setCanvasSize(project(), 3840, 2160), '1\n00:00:00,000 --> 00:00:01,000\nHello\n')
    load(p)
    const cap = p.tracks.find((t) => t.kind === 'caption')!
    S().select([cap.items[0].id])
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Boxed/ }))
    const style = S().project.tracks.find((t) => t.kind === 'caption')!.captionStyle!
    expect(style.preset).toBe('boxed')
    expect(style.style.fontSize).toBe(100)
  })
})

describe('properties panel resets (EDT-31, EDT-32)', () => {
  const basicTab = (p: Project) => {
    load(p)
    S().select(['v1'])
    S().set({ activeRightTab: 'basic' })
    render(<PropertiesPanel />)
  }
  const rangeFor = (label: string) => screen.getAllByText(label).map((el) => el.closest('.ed-field')?.querySelector('input[type="range"]')).find(Boolean) as HTMLInputElement

  it('Reset transform clears position, scale and rotation keyframes but keeps opacity and volume ones', () => {
    let p = updateItem<VideoItem>(project(), 'v1', { transform: { x: 50, y: 20, scale: 1.4, rotation: 10 } })
    p = setKeyframe(setKeyframe(setKeyframe(p, 'v1', 'x', 1, 200), 'v1', 'opacity', 2, 0.4), 'v1', 'volume', 3, 0.5)
    basicTab(p)
    fireEvent.click(screen.getByTitle('Reset transform'))
    const v = findItem(S().project, 'v1')!.item as VideoItem
    expect(v.transform).toEqual({ x: 0, y: 0, scale: 1, rotation: 0 })
    expect(Object.keys(v.keyframes).sort()).toEqual(['opacity', 'volume'])
  })

  it('double-clicking the opacity or scale slider resets it to 100%, not 0', () => {
    basicTab(updateItem<VideoItem>(project(), 'v1', { opacity: 0.3, transform: { x: 0, y: 0, scale: 2, rotation: 0 } }))
    fireEvent.doubleClick(rangeFor('Opacity'))
    fireEvent.doubleClick(rangeFor('Scale'))
    const v = findItem(S().project, 'v1')!.item as VideoItem
    expect(v.opacity).toBe(1)
    expect(v.transform.scale).toBe(1)
  })

  it('and the volume slider too', () => {
    load(updateItem<VideoItem>(project(), 'v1', { volume: 0.2 }))
    S().select(['v1'])
    S().set({ activeRightTab: 'audio' })
    render(<PropertiesPanel />)
    fireEvent.doubleClick(rangeFor('Volume'))
    expect((findItem(S().project, 'v1')!.item as VideoItem).volume).toBe(1)
  })
})

describe('context-menu actions (EDT-33)', () => {
  it('Freeze frame acts on the clip right-clicked, not the one under the playhead', () => {
    S().select(['v1'])
    S().setPlayhead(5)
    // right-clicked v2 at 13 s with the playhead over v1
    A.freezeClip('v2', 13)
    const items = mainTrack(S().project)!.items as VideoItem[]
    // v1 untouched; v2 cut at 13 s with the hold in between
    expect(items.map((i) => (i.freezeAt !== undefined ? 'hold' : i.assetId))).toEqual(['as_a', 'as_b', 'hold', 'as_b'])
    expect(items.map((i) => i.start)).toEqual([0, 10, 13, 15])
    expect(items[2].freezeAt).toBeCloseTo(3, 3)
  })

  it('the Speed tab button still freezes the frame under the playhead', () => {
    S().select(['v1'])
    S().setPlayhead(4)
    S().set({ activeRightTab: 'speed' })
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Freeze frame at playhead/ }))
    const holds = (mainTrack(S().project)!.items as VideoItem[]).filter((i) => i.freezeAt !== undefined)
    expect(holds.map((h) => [h.start, h.freezeAt])).toEqual([[4, 4]])
  })

  it('the cut button between two text clips adds a transition', () => {
    let p = addItem(project(), createTextItem(0, 'heading', { id: 't1', duration: 2 }))
    p = addItem(p, createTextItem(2, 'heading', { id: 't2', duration: 2 }), findItem(p, 't1')!.track.id)
    load(p)
    A.setTransition('t1', 'crossfade', 0.6)
    expect((findItem(S().project, 't1')!.item as VisualItem).transitionOut).toEqual({ type: 'crossfade', duration: 0.6 })
  })
})
