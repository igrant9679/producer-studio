// Editor shortcuts leave focused controls, selected text and the transcript their own keys (EDT-10, EDT-37).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, type Asset, type Project } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TranscriptPanel } from '../panels/TranscriptPanel'
import { useShortcuts } from '../shortcuts'
import { useEditor } from '../store'

const S = () => useEditor.getState()

const words = [
  { w: 'Hello', start: 0.2, end: 0.6 },
  { w: 'there', start: 0.7, end: 1.1 },
]
const asset: Asset = {
  id: 'as1', kind: 'video', name: 'talk.mp4', src: '/api/media/as1/source', duration: 5, width: 1920, height: 1080, hasAudio: true,
  transcript: { language: 'en', engine: 'test', segments: [{ start: 0.2, end: 1.1, text: 'Hello there', words }] },
}

function project(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, asset)
  return addItem(p, createVideoItem(p.assets.as1, 0))
}

function Shortcuts() {
  useShortcuts()
  return null
}

const clips = () => S().project.tracks.flatMap((t) => t.items)

beforeEach(() => {
  S().load({ project: project(), version: 1, projectId: 'p1', demo: true })
})
afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
})

describe('the transcript keeps Delete and Backspace (EDT-10)', () => {
  it('Delete with no words selected leaves the clip on the timeline', () => {
    S().select([clips()[0].id])
    render(<><Shortcuts /><TranscriptPanel /></>)
    const box = document.querySelector('.ed-words') as HTMLElement
    act(() => box.focus())
    fireEvent.keyDown(box, { key: 'Delete' })
    fireEvent.keyDown(box, { key: 'Backspace' })
    expect(clips()).toHaveLength(1)
  })

  it('Delete with words selected cuts only those words', () => {
    render(<><Shortcuts /><TranscriptPanel /></>)
    fireEvent.mouseDown(screen.getByText('Hello'))
    fireEvent.keyDown(document.querySelector('.ed-words')!, { key: 'Delete' })
    // the clip is still there, now starting after the cut word
    expect(clips().length).toBeGreaterThan(0)
    expect(S().history.past.at(-1)?.label).toBe('Delete words')
  })
})

describe('focused controls and selected text keep their keys (EDT-37)', () => {
  it('Space on a button reached with Tab presses the button, not play', () => {
    render(<><Shortcuts /><button>Split</button></>)
    const btn = screen.getByRole('button', { name: 'Split' })
    // the Tab that reaches it (a mouse press from the test before could otherwise still count)
    fireEvent.keyDown(document.body, { key: 'Tab' })
    act(() => btn.focus())
    const ev = fireEvent.keyDown(btn, { key: ' ' })
    expect(ev).toBe(true) // not prevented: the browser clicks the button
    expect(S().playing).toBe(false)
  })

  it('Space after clicking a button with the mouse still plays', () => {
    render(<><Shortcuts /><button>Split</button></>)
    const btn = screen.getByRole('button', { name: 'Split' })
    fireEvent.pointerDown(btn)
    act(() => btn.focus())
    fireEvent.keyDown(btn, { key: ' ' })
    expect(S().playing).toBe(true)
  })

  it('Backspace on a checkbox or slider does not delete the selected clip', () => {
    S().select([clips()[0].id])
    render(<><Shortcuts /><input type="checkbox" aria-label="Loop" /><input type="range" aria-label="Volume" /></>)
    for (const name of ['Loop', 'Volume']) {
      const el = screen.getByRole(name === 'Loop' ? 'checkbox' : 'slider', { name })
      act(() => el.focus())
      fireEvent.keyDown(el, { key: 'Backspace' })
    }
    expect(clips()).toHaveLength(1)
  })

  it('a slider clicked with the mouse still moves with the arrows, not the playhead', () => {
    render(<><Shortcuts /><input type="range" aria-label="Volume" /></>)
    const el = screen.getByRole('slider', { name: 'Volume' })
    fireEvent.pointerDown(el)
    act(() => el.focus())
    fireEvent.keyDown(el, { key: 'ArrowRight' })
    expect(S().playhead).toBe(0)
  })

  it('Ctrl+C with text selected copies the text, not the clips', () => {
    S().select([clips()[0].id])
    render(<><Shortcuts /><p>Some note to copy</p></>)
    const range = document.createRange()
    range.selectNodeContents(screen.getByText('Some note to copy'))
    window.getSelection()!.addRange(range)
    const ev = fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true })
    expect(ev).toBe(true)
    expect(S().clipboard).toHaveLength(0)
    // nothing selected: Ctrl+C copies the clip
    window.getSelection()!.removeAllRanges()
    fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true })
    expect(S().clipboard).toHaveLength(1)
  })
})
