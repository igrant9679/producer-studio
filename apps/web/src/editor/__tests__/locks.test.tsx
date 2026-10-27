// A locked track holds against every edit control: actions, the properties panel and transcript cuts.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, mainTrack, updateTrack, type Asset, type Project } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useToasts } from '../../lib/toast'
import * as A from '../actions'
import { TranscriptPanel } from '../panels/TranscriptPanel'
import { PropertiesPanel } from '../PropertiesPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()
const toasts = () => useToasts.getState().toasts.map((t) => t.text)

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

function lockedProject(): Project {
  let p = addAsset(createProject({ id: 'p1', name: 'Locks' }), clip)
  p = addItem(p, createVideoItem(clip, 0, { id: 'v1' }))
  return updateTrack(p, mainTrack(p)!.id, { locked: true })
}

beforeEach(() => {
  useToasts.setState({ toasts: [] })
  S().load({ project: lockedProject(), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  S().select(['v1'])
  S().setPlayhead(4)
})

afterEach(cleanup)

describe('locked track (EDT-19)', () => {
  it('split, delete, duplicate, freeze and separate say the track is locked and change nothing', () => {
    const before = S().project
    for (const run of [A.split, () => A.remove(), A.duplicate, () => A.freeze(), A.separate]) run()
    expect(S().project).toBe(before)
    expect(S().history.past).toHaveLength(0)
    expect(toasts().filter((t) => t === A.LOCKED_NOTE)).toHaveLength(5)
  })

  it('the properties panel says so and its controls are disabled', () => {
    render(<PropertiesPanel />)
    expect(screen.getByRole('note').textContent).toBe(A.LOCKED_NOTE)
    const sliders = screen.getAllByRole('slider') as HTMLInputElement[]
    expect(sliders.length).toBeGreaterThan(0)
    // a disabled fieldset disables everything inside it
    for (const el of [...sliders, screen.getByTitle('Reset transform')]) expect(el.matches(':disabled')).toBe(true)
  })

  it('a transcript cut on a locked clip reports nothing removed', async () => {
    render(<TranscriptPanel />)
    await act(async () => fireEvent.mouseDown(screen.getByText('one')))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Cut 1/ })))
    expect(toasts()).toContain(A.LOCKED_NOTE)
    expect(toasts().some((t) => /removed/.test(t))).toBe(false)
    expect(S().history.past).toHaveLength(0)
  })
})
