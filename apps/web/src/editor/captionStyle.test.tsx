import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { CAPTION_PRESETS, addAsset, addItem, createProject, createVideoItem, generateCaptions, importSrt, type CaptionItem, type Project } from '@producer/core'
import { afterEach, describe, expect, it } from 'vitest'
import { CaptionStyleEditor } from './PropertiesPanel'
import { useEditor } from './store'

const SRT = '1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line\n'
const S = () => useEditor.getState()
const captionTracks = () => S().project.tracks.filter((t) => t.kind === 'caption')
const lines = () => captionTracks()[0].items as CaptionItem[]

function open(project: Project) {
  S().load({ project, version: 1, projectId: project.id, demo: true })
  return render(<CaptionStyleEditor track={captionTracks()[0]} />)
}

function pickPreset(container: HTMLElement, name: string) {
  fireEvent.click(within(container.querySelector<HTMLElement>('.ed-capgrid')!).getByText(name))
}

function wordsPerLine(container: HTMLElement, n: number) {
  const field = [...container.querySelectorAll('.ed-field')].find((f) => f.querySelector('label')?.textContent === 'Words / line')!
  fireEvent.change(field.querySelector('input[type=range]')!, { target: { value: String(n) } })
}

/** A clip with a transcript, captioned from it. */
function captioned(): Project {
  let p = createProject({ id: 'p_cap' })
  p = addAsset(p, {
    id: 'a',
    kind: 'video',
    name: 'a.mp4',
    src: 'a.mp4',
    duration: 10,
    transcript: {
      language: 'en',
      engine: 'test',
      segments: [{ start: 0, end: 4, text: 'one two three four five six', words: ['one', 'two', 'three', 'four', 'five', 'six'].map((w, i) => ({ w, start: i * 0.5, end: i * 0.5 + 0.4 })) }],
    },
  })
  p = addItem(p, createVideoItem(p.assets.a, 0))
  return generateCaptions(p)
}

afterEach(cleanup)

describe('caption style editor (EDT-4)', () => {
  it('keeps an imported .srt through every preset and every line length', () => {
    const { container } = open(importSrt(createProject({ id: 'p_srt' }), SRT))
    for (const preset of CAPTION_PRESETS) {
      pickPreset(container, preset.name)
      expect(captionTracks()).toHaveLength(1)
      expect(captionTracks()[0].captionStyle?.preset).toBe(preset.id)
      expect(lines().map((c) => c.text)).toEqual(['Hello there', 'Second line'])
    }
    for (const n of [1, 4, 14]) {
      wordsPerLine(container, n)
      expect(lines().map((c) => [c.start, c.duration, c.text])).toEqual([
        [1, 1.5, 'Hello there'],
        [3, 1, 'Second line'],
      ])
    }
  })

  it('re-breaks captions made from a transcript when the line length changes', () => {
    const { container } = open(captioned())
    expect(lines().map((c) => c.text)).toEqual(['one two three four five six'])
    wordsPerLine(container, 2)
    expect(lines().map((c) => c.text)).toEqual(['one two', 'three four', 'five six'])
  })

  it('leaves the lines alone when a preset only changes the look', () => {
    const { container } = open(captioned())
    wordsPerLine(container, 8) // Boxed breaks at 8 words too
    const before = lines()
    pickPreset(container, 'Boxed')
    expect(captionTracks()[0].captionStyle?.preset).toBe('boxed')
    expect(lines()).toEqual(before)
  })
})
