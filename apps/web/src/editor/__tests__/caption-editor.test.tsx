// The caption line editor and caption tracks in the Captions panel (E-12): retime, split, merge, karaoke word
// timings by keyboard, subtitle files in (a new track in the file's language) and out, which track is shown.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addAsset, addItem, captionTracks, createProject, createVideoItem, generateCaptions, type Asset, type CaptionItem, type Project } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptionsPanel } from '../panels/CaptionsPanel'
import { PropertiesPanel } from '../PropertiesPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()

const talk: Asset = {
  id: 'as1',
  kind: 'video',
  name: 'talk.mp4',
  src: '/api/media/as1/source',
  duration: 10,
  hasAudio: true,
  transcript: { language: 'en', engine: 'test', segments: [{ start: 0, end: 5, text: 'one two three four', words: [{ w: 'one', start: 0.5, end: 0.9 }, { w: 'two', start: 1.0, end: 1.4 }, { w: 'three', start: 1.5, end: 1.9 }, { w: 'four.', start: 2.0, end: 2.4 }] }] },
}

function project(): Project {
  let p = addAsset(createProject({ id: 'p1', name: 'Talk' }), talk)
  p = addItem(p, createVideoItem(p.assets.as1, 0))
  return generateCaptions(p)
}

const lines = (trackIndex = 0) => captionTracks(S().project)[trackIndex].items as CaptionItem[]
const lineButton = (text: RegExp) => within(screen.getByRole('list', { name: 'Caption lines' })).getByRole('button', { name: text })

// jsdom's Blob has no text(); browsers do
if (!Blob.prototype.text)
  Blob.prototype.text = function (this: Blob) {
    return new Promise<string>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.readAsText(this)
    })
  }

/** Picks a file in a file input and waits for it to be read. */
async function upload(input: HTMLInputElement, file: File) {
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
    await new Promise((r) => setTimeout(r, 50))
  })
}

beforeEach(() => {
  S().load({ project: project(), version: 1, projectId: 'p1', demo: true })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('caption line editor', { timeout: 40_000 }, () => {
  it('picking a line opens its editor; times are typed, the words keep their moments', () => {
    render(<CaptionsPanel />)
    const row = lineButton(/one two three four/)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(S().selection).toEqual([lines()[0].id])
    const start = screen.getByRole('textbox', { name: 'Start (seconds)' })
    fireEvent.change(start, { target: { value: '0.2' } })
    fireEvent.keyDown(start, { key: 'Enter' })
    fireEvent.blur(start)
    expect(lines()[0].start).toBeCloseTo(0.2, 4)
    expect(lines()[0].start + lines()[0].words![0].start).toBeCloseTo(0.5, 4)
    expect(S().history.past.at(-1)?.label).toBe('Retime caption')
  })

  it('splits at the cursor (button or Ctrl+Enter) and merges back', () => {
    render(<CaptionsPanel />)
    fireEvent.click(lineButton(/one two three four/))
    const text = screen.getByRole('textbox', { name: 'Caption text' }) as HTMLTextAreaElement
    text.setSelectionRange(8, 8)
    fireEvent.click(screen.getByRole('button', { name: /Split at cursor/ }))
    expect(lines().map((c) => c.text)).toEqual(['one two', 'three four.'])
    expect(lines()[1].start).toBeCloseTo(1.5, 4)
    // the left line stays open; merge it with the next
    fireEvent.click(screen.getByRole('button', { name: /Merge with next/ }))
    expect(lines().map((c) => c.text)).toEqual(['one two three four.'])
    const again = screen.getByRole('textbox', { name: 'Caption text' }) as HTMLTextAreaElement
    again.setSelectionRange(4, 4)
    fireEvent.keyDown(again, { key: 'Enter', ctrlKey: true })
    expect(lines().map((c) => c.text)).toEqual(['one', 'two three four.'])
  })

  it('a typo fix keeps the karaoke timings', () => {
    render(<CaptionsPanel />)
    fireEvent.click(lineButton(/one two three four/))
    fireEvent.change(screen.getByRole('textbox', { name: 'Caption text' }), { target: { value: 'one too three four.' } })
    expect(lines()[0].words!.map((w) => w.w)).toEqual(['one', 'too', 'three', 'four.'])
  })

  it('moves a word’s edges with the arrow keys, never past its neighbour', () => {
    render(<CaptionsPanel />)
    fireEvent.click(lineButton(/one two three four/))
    const end = screen.getByRole('slider', { name: 'End of “one”' })
    const before = lines()[0].words![0].end
    fireEvent.keyDown(end, { key: 'ArrowRight' })
    expect(lines()[0].words![0].end).toBeCloseTo(before + 0.01, 4)
    fireEvent.keyDown(screen.getByRole('slider', { name: 'End of “one”' }), { key: 'ArrowRight', shiftKey: true })
    // stops where "two" starts
    expect(lines()[0].words![0].end).toBeCloseTo(lines()[0].words![1].start, 4)
    // picking a word types its times
    fireEvent.click(screen.getByRole('button', { name: 'Word 2: two' }))
    const from = screen.getByRole('textbox', { name: 'Start of “two” (seconds into the line)' })
    expect(from).toBeTruthy()
    // only the picked word's edges are in the Tab order
    expect(screen.getByRole('slider', { name: 'Start of “two”' }).tabIndex).toBe(0)
    expect(screen.getByRole('slider', { name: 'End of “one”' }).tabIndex).toBe(-1)
  })

  it('an imported line gets word timings to edit', async () => {
    render(<CaptionsPanel />)
    const input = document.querySelectorAll('input[type=file]')[0] as HTMLInputElement
    await upload(input, new File(['1\n00:00:05,000 --> 00:00:07,000\nhola amigos\n'], 'talk.es.srt'))
    fireEvent.click(lineButton(/hola amigos/))
    fireEvent.click(screen.getByRole('button', { name: /Time the words/ }))
    expect(lines(1)[0].words!.map((w) => w.w)).toEqual(['hola', 'amigos'])
  })
})

describe('caption tracks and files', { timeout: 40_000 }, () => {
  it('imports a file as a new track in its language, shown instead of the first; exports the track picked', async () => {
    const urls: Blob[] = []
    URL.createObjectURL = vi.fn((b: Blob) => (urls.push(b), 'blob:x'))
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(<CaptionsPanel />)
    const input = document.querySelectorAll('input[type=file]')[0] as HTMLInputElement
    const vtt = 'WEBVTT\n\n00:00.500 --> 00:02.400\nuno dos tres cuatro\n'
    await upload(input, new File([vtt], 'talk.es.vtt'))
    expect(captionTracks(S().project)).toHaveLength(2)
    const picker = screen.getByRole('combobox', { name: 'Caption track' }) as HTMLSelectElement
    expect(picker.selectedOptions[0].textContent).toBe('Captions · Spanish (es)')
    expect(within(picker).getByRole('option', { name: /English \(en\) \(hidden\)/ })).toBeTruthy()
    expect((screen.getByRole('switch', { name: 'In the video' }) as HTMLInputElement).checked).toBe(true)
    expect(captionTracks(S().project).map((t) => !!t.hidden)).toEqual([true, false])

    fireEvent.change(screen.getByRole('combobox', { name: 'Caption file format' }), { target: { value: 'vtt' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Include word timings (karaoke)' }))
    // back to English, shown again
    fireEvent.change(picker, { target: { value: captionTracks(S().project)[0].id } })
    fireEvent.click(screen.getByRole('switch', { name: 'In the video' }))
    expect(captionTracks(S().project).map((t) => !!t.hidden)).toEqual([false, true])
    fireEvent.click(screen.getByRole('button', { name: /Export/ }))
    expect(click).toHaveBeenCalledOnce()
    const out = await urls[0].text()
    expect(out.startsWith('WEBVTT\nLanguage: en')).toBe(true)
    expect(out).toContain('<00:00:01.000>two')
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('Talk.en.vtt')
  })

  it('names a track’s language, adds an empty track, and replaces a track’s lines from a file', async () => {
    render(<CaptionsPanel />)
    const lang = screen.getByRole('combobox', { name: 'Language' }) as HTMLInputElement
    fireEvent.change(lang, { target: { value: 'en-GB' } })
    fireEvent.keyDown(lang, { key: 'Enter' })
    fireEvent.blur(lang)
    expect(captionTracks(S().project)[0].language).toBe('en-GB')
    fireEvent.click(screen.getByRole('button', { name: /Track/ }))
    expect(captionTracks(S().project)).toHaveLength(2)
    expect((screen.getByRole('combobox', { name: 'Caption track' }) as HTMLSelectElement).selectedOptions[0].textContent).toBe('Captions 2')
    const replace = document.querySelectorAll('input[type=file]')[1] as HTMLInputElement
    await upload(replace, new File(['[00:01.00]la la\n'], 'song.lrc'))
    expect(captionTracks(S().project)).toHaveLength(2)
    expect(lines(1).map((c) => c.text)).toEqual(['la la'])
    expect(S().history.past.at(-1)?.label).toBe('Replace captions')
  })
})

describe('the Properties caption tab', { timeout: 40_000 }, () => {
  it('keeps the karaoke timing of the words that survive a text edit', () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    const line = lines()[0]
    expect(line.words?.length).toBeGreaterThan(1)
    S().select([line.id])
    S().set({ activeRightTab: 'caption' })
    render(<PropertiesPanel />)
    const box = screen.getByDisplayValue(line.text)
    fireEvent.change(box, { target: { value: line.text.replace('two', 'too') } })
    const after = lines()[0]
    expect(after.text).toContain('too')
    expect(after.words?.map((w) => w.start)).toEqual(line.words?.map((w) => w.start))
  })
})
