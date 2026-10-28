// Descript-style transcript editing (E-11): cut words stay struck through and come back with R, by mouse or
// keyboard; captions follow; the filler list; speaker labels (renamed and assigned by editors, not viewers).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, generateCaptions, mainTrack, type Asset, type AssetRecord, type CaptionItem, type Project, type Transcript } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { TranscriptPanel } from '../panels/TranscriptPanel'
import { useShortcuts } from '../shortcuts'
import { useEditor } from '../store'

const S = () => useEditor.getState()

const transcript: Transcript = {
  language: 'en',
  engine: 'test',
  segments: [
    { start: 0, end: 1.6, text: 'Hello um there', speaker: 'Alex', words: [{ w: 'Hello', start: 0.2, end: 0.6 }, { w: 'um', start: 0.7, end: 0.9 }, { w: 'there', start: 1.0, end: 1.4 }] },
    { start: 1.6, end: 3, text: 'I like it', speaker: 'Sam', words: [{ w: 'I', start: 1.7, end: 1.8 }, { w: 'like', start: 1.9, end: 2.2 }, { w: 'it.', start: 2.3, end: 2.6 }] },
  ],
}
const asset: Asset = { id: 'as1', kind: 'video', name: 'talk.mp4', src: '/api/media/as1/source', duration: 5, width: 1920, height: 1080, hasAudio: true, transcript }

function project(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, asset)
  return generateCaptions(addItem(p, createVideoItem(p.assets.as1, 0)))
}

function Shortcuts() {
  useShortcuts()
  return null
}

const main = () => mainTrack(S().project)!.items
const box = () => document.querySelector('.ed-words') as HTMLElement
const word = (w: string) => screen.getAllByText(w).find((el) => el.classList.contains('w'))!
const captionText = () => S().project.tracks.filter((t) => t.kind === 'caption').flatMap((t) => t.items as CaptionItem[]).map((c) => c.text).join(' ')

beforeEach(() => {
  useSession.setState({ workspaces: [] })
  S().load({ project: project(), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('struck words', { timeout: 40_000 }, () => {
  it('Delete strikes a word through instead of losing it; R brings it back, and the captions follow both ways', () => {
    render(<><Shortcuts /><TranscriptPanel /></>)
    fireEvent.mouseDown(word('um'))
    fireEvent.keyDown(box(), { key: 'Delete' })
    expect(S().history.past.at(-1)?.label).toBe('Delete words')
    expect(main()).toHaveLength(2)
    // still in the transcript, struck through
    const um = word('um')
    expect(um.tagName).toBe('DEL')
    expect(captionText()).not.toContain('um')
    fireEvent.mouseDown(um)
    expect(screen.getByRole('button', { name: /Restore 1/ })).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'r' })
    expect(S().history.past.at(-1)?.label).toBe('Restore words')
    expect(main()).toHaveLength(1)
    expect(main()[0].duration).toBeCloseTo(5, 3)
    expect(word('um').tagName).toBe('SPAN')
    expect(captionText()).toContain('Hello um there')
  })

  it('works by keyboard: arrows move through the words, Shift extends, Delete cuts, R restores', () => {
    render(<><Shortcuts /><TranscriptPanel /></>)
    act(() => box().focus())
    fireEvent.keyDown(box(), { key: 'ArrowRight' })
    expect(word('Hello').classList.contains('sel')).toBe(true)
    // the playhead jumps to the word
    expect(S().playhead).toBeCloseTo(0.201, 3)
    fireEvent.keyDown(box(), { key: 'ArrowRight' })
    fireEvent.keyDown(box(), { key: 'ArrowRight', shiftKey: true })
    expect(word('um').classList.contains('sel')).toBe(true)
    expect(word('there').classList.contains('sel')).toBe(true)
    expect(word('Hello').classList.contains('sel')).toBe(false)
    fireEvent.keyDown(box(), { key: 'Delete' })
    expect(word('um').tagName).toBe('DEL')
    expect(word('there').tagName).toBe('DEL')
    // the global shortcuts never saw the arrows or the R
    expect(main().length).toBeGreaterThan(1)
    fireEvent.keyDown(box(), { key: 'End' })
    fireEvent.keyDown(box(), { key: 'Home' })
    fireEvent.keyDown(box(), { key: 'ArrowRight' })
    fireEvent.keyDown(box(), { key: 'ArrowRight', shiftKey: true })
    expect(screen.getByRole('button', { name: /Restore 2/ })).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'R' })
    expect(word('there').tagName).toBe('SPAN')
    expect(main()).toHaveLength(1)
  })

  it('a selected clip shows the pieces its cut made, so the struck words stay in view', () => {
    S().select([main()[0].id])
    render(<TranscriptPanel />)
    fireEvent.mouseDown(word('um'))
    fireEvent.keyDown(box(), { key: 'Delete' })
    expect(S().selection).toEqual([main()[0].id])
    expect(word('um').tagName).toBe('DEL')
    expect(word('it.')).toBeTruthy()
  })
})

describe('filler words', { timeout: 40_000 }, () => {
  it('the list switches a word on or off, takes your own, and Remove takes out only the ones switched on', () => {
    render(<TranscriptPanel />)
    expect(word('um').classList.contains('filler')).toBe(true)
    expect(word('like').classList.contains('filler')).toBe(false)
    const toggle = screen.getByRole('button', { name: 'Edit the filler word list' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const like = screen.getByRole('button', { name: 'like 1' })
    expect(like.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(like)
    expect(S().history.past.at(-1)?.label).toBe('Filler “like” on')
    expect(screen.getByRole('button', { name: 'like 1' }).getAttribute('aria-pressed')).toBe('true')
    expect(word('like').classList.contains('filler')).toBe(true)
    // a word of your own, added with Enter
    const add = screen.getByRole('textbox', { name: 'Add a filler word or phrase' })
    fireEvent.change(add, { target: { value: 'it' } })
    fireEvent.keyDown(add, { key: 'Enter' })
    expect(S().project.fillerWords?.find((f) => f.w === 'it')?.on).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Take “it” off the list' }))
    expect(S().project.fillerWords?.some((f) => f.w === 'it')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Filler words \(2\)/ }))
    expect(S().history.past.at(-1)?.label).toBe('Remove filler words')
    expect(word('um').tagName).toBe('DEL')
    expect(word('like').tagName).toBe('DEL')
    // the words between them stay
    expect(word('I').tagName).toBe('SPAN')
    expect(word('there').tagName).toBe('SPAN')
  })
})

describe('speakers', { timeout: 40_000 }, () => {
  it('labels each speaker’s words; Enter renames one everywhere and saves it on the clip, Escape keeps the name', async () => {
    const save = vi.spyOn(api, 'setTranscript').mockResolvedValue({} as AssetRecord)
    render(<TranscriptPanel />)
    const alex = screen.getByRole('button', { name: 'Speaker: Alex. Rename' })
    expect(screen.getByRole('button', { name: 'Speaker: Sam. Rename' })).toBeTruthy()
    fireEvent.click(alex)
    const input = screen.getByRole('textbox', { name: 'Rename Alex' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Speaker: Alex. Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Rename Alex' }), { target: { value: 'Alexandra' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename Alex' }), { key: 'Enter' })
    expect(save).toHaveBeenCalledOnce()
    expect(save.mock.calls[0][1].segments.map((s) => s.speaker)).toEqual(['Alexandra', 'Sam'])
    // a media record: on the clip, not an undo step
    expect(S().project.assets.as1.transcript?.segments[0].speaker).toBe('Alexandra')
    expect(S().history.past).toHaveLength(0)
    await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Speaker: Alexandra. Rename' }))
  })

  it('gives selected words to a speaker, splitting the segment', () => {
    const save = vi.spyOn(api, 'setTranscript').mockResolvedValue({} as AssetRecord)
    render(<TranscriptPanel />)
    fireEvent.mouseDown(word('like'))
    fireEvent.mouseDown(word('it.'), { shiftKey: true })
    fireEvent.change(screen.getByRole('combobox', { name: 'Speaker' }), { target: { value: '__new' } })
    expect(save.mock.calls[0][1].segments.map((s) => [s.text, s.speaker])).toEqual([
      ['Hello um there', 'Alex'],
      ['I', 'Sam'],
      ['like it.', 'Speaker 3'],
    ])
    expect(screen.getByRole('button', { name: 'Speaker: Speaker 3. Rename' })).toBeTruthy()
  })

  it('a viewer sees the labels but cannot rename or assign them', () => {
    const save = vi.spyOn(api, 'setTranscript').mockResolvedValue({} as AssetRecord)
    useSession.setState({ workspaces: [{ id: 'w1', name: 'Client', role: 'viewer', personal: false, memberCount: 2 }] })
    render(<TranscriptPanel />)
    const alex = screen.getByRole('button', { name: 'Speaker: Alex. Rename' }) as HTMLButtonElement
    expect(alex.disabled).toBe(true)
    expect(alex.getAttribute('data-tip')).toMatch(/viewer/)
    fireEvent.mouseDown(word('like'))
    expect((screen.getByRole('combobox', { name: 'Speaker' }) as HTMLSelectElement).disabled).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })
})
