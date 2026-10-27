// Edit actions and properties-panel edits from the phase 4 pass.
import { cleanup } from '@testing-library/react'
import { addAsset, addItem, createProject, createTextItem, createVideoItem, findItem, mainTrack, type Asset, type Project, type VideoItem, type VisualItem } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useToasts } from '../../lib/toast'
import * as A from '../actions'
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

describe('context-menu actions (EDT-33)', () => {
  it('Freeze frame acts on the clip right-clicked, not the one under the playhead', () => {
    S().select(['v1'])
    S().setPlayhead(5)
    // right-clicked v2 at 13 s with the playhead over v1
    A.freeze({ itemId: 'v2', at: 13 })
    const items = mainTrack(S().project)!.items as VideoItem[]
    // v1 untouched; v2 cut at 13 s with the hold in between
    expect(items.map((i) => (i.freezeAt !== undefined ? 'hold' : i.assetId))).toEqual(['as_a', 'as_b', 'hold', 'as_b'])
    expect(items.map((i) => i.start)).toEqual([0, 10, 13, 15])
    expect(items[2].freezeAt).toBeCloseTo(3, 3)
  })

  it('the cut button between two text clips adds a transition', () => {
    let p = addItem(project(), createTextItem(0, 'heading', { id: 't1', duration: 2 }))
    p = addItem(p, createTextItem(2, 'heading', { id: 't2', duration: 2 }), findItem(p, 't1')!.track.id)
    load(p)
    A.setTransition('t1', 'crossfade', 0.6)
    expect((findItem(S().project, 't1')!.item as VisualItem).transitionOut).toEqual({ type: 'crossfade', duration: 0.6 })
  })
})
