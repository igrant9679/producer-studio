// Editor requests from the tracker: one transition on many cuts (#10), number boxes with up/down steppers (#4; Shift
// steps by ten in a browser, which jsdom's pointer events can't carry), and
// the caption box's colour, opacity, corners and padding (#14).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addAsset, addItem, captionStyleFromPreset, createProject, createTrack, createVideoItem, findItem, type Asset, type Project, type VisualItem } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as A from '../actions'
import { NumberInput } from '../controls'
import { CaptionStyleEditor } from '../PropertiesPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()
const clip = (id: string, duration = 5): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration, width: 1920, height: 1080 })

/** Main: v1 v2 v3 touching, v4 after a gap; overlay: o1 o2 touching. */
function project(): Project {
  let p = createProject({ id: 'p1', name: 'Cuts' })
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) p = addAsset(p, clip(id))
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'v1' }))
  p = addItem(p, createVideoItem(p.assets.b, 5, { id: 'v2' }))
  p = addItem(p, createVideoItem(p.assets.c, 10, { id: 'v3' }))
  const overlay = createTrack('overlay', { name: 'Overlay' })
  p = { ...p, tracks: [...p.tracks, overlay] }
  p = addItem(p, createVideoItem(p.assets.e, 0, { id: 'o1' }), overlay.id)
  return addItem(p, createVideoItem(p.assets.f, 5, { id: 'o2' }), overlay.id)
}

beforeEach(() => S().load({ project: project(), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' }))
afterEach(cleanup)

describe('one transition on many cuts', () => {
  it('finds the cuts of a track, of the selected clips, or of the whole video', () => {
    const p = S().project
    const main = p.tracks.find((t) => t.main)!
    expect(A.transitionCuts(p, { trackId: main.id })).toEqual(['v1', 'v2'])
    expect(A.transitionCuts(p, 'all')).toEqual(['v1', 'v2', 'o1'])
    // a cut counts when either side is selected
    expect(A.transitionCuts(p, { selected: ['v3', 'o1'] })).toEqual(['v2', 'o1'])
  })

  it('sets them all in one undo step', () => {
    A.setTransitionOn(A.transitionCuts(S().project, 'all'), 'slideLeft' as never, 0.8)
    const tr = (id: string) => (findItem(S().project, id)!.item as VisualItem).transitionOut
    expect([tr('v1'), tr('v2'), tr('o1')]).toEqual([{ type: 'slideLeft', duration: 0.8 }, { type: 'slideLeft', duration: 0.8 }, { type: 'slideLeft', duration: 0.8 }])
    expect(tr('v3')).toBeUndefined()
    S().undo()
    expect(tr('v1')).toBeUndefined()
  })
})

describe('number boxes', () => {
  it('step up and down with their arrows, inside their limits', () => {
    let v = 10
    const box = () => <NumberInput value={v} min={0} max={11} label="Opacity value" onChange={(x) => (v = x)} />
    const { rerender } = render(box())
    const press = (name: string) => {
      fireEvent.pointerDown(screen.getByRole('button', { name }))
      fireEvent.pointerUp(screen.getByRole('button', { name }))
      rerender(box())
    }
    press('Increase Opacity')
    expect(v).toBe(11)
    press('Increase Opacity')
    expect(v).toBe(11)
    press('Decrease Opacity')
    expect(v).toBe(10)
  })
})

describe('the caption box', () => {
  it('has its colour, opacity, corners and padding once it is on, for every caption on the track', () => {
    const t = createTrack('caption', { name: 'Captions' })
    t.captionStyle = captionStyleFromPreset('boxed')
    S().load({ project: { ...S().project, tracks: [...S().project.tracks, t] }, version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
    render(<CaptionStyleEditor track={S().project.tracks.find((x) => x.id === t.id)!} />)
    expect(screen.getByText(/apply to every caption on this track/)).toBeTruthy()
    for (const name of ['Box opacity', 'Corners', 'Padding']) expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    fireEvent.change(screen.getByRole('textbox', { name: /Box opacity value/ }), { target: { value: '40' } })
    fireEvent.blur(screen.getByRole('textbox', { name: /Box opacity value/ }))
    expect(S().project.tracks.find((x) => x.id === t.id)!.captionStyle!.style.background!.opacity).toBeCloseTo(0.4)
  })
})
