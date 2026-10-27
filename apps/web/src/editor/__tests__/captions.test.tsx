// Captions from the Captions panel: never shorter than a frame.
import { addAsset, addItem, captionStyleFromPreset, createAudioItem, createProject, generateCaptions, type Asset, type Project } from '@producer/core'
import { describe, expect, it } from 'vitest'
import { captionsAtLeastOneFrame } from '../actions'

const voice: Asset = {
  id: 'as_voice',
  kind: 'audio',
  name: 'voice',
  src: '/api/media/as_voice/source',
  duration: 4,
  hasAudio: true,
  transcript: { language: 'en', engine: 'test', segments: [{ start: 0, end: 1, text: 'Hello there', words: [{ w: 'Hello', start: 0, end: 0.4 }, { w: 'there', start: 0.5, end: 0.9 }] }] },
}

/** The same voice on two audio tracks: their words start together. */
function twoVoices(): Project {
  let p = addAsset(createProject({ id: 'p1', name: 'Captions' }), voice)
  p = addItem(p, createAudioItem(voice, 0))
  return addItem(p, createAudioItem(voice, 0))
}

const captions = (p: Project) => p.tracks.filter((t) => t.kind === 'caption').flatMap((t) => t.items)

describe('caption length', () => {
  it('stretches generated captions that would be zero-length to one frame', () => {
    const p = twoVoices()
    const generated = generateCaptions(p, { style: { ...captionStyleFromPreset('clean'), maxWordsPerLine: 1 } })
    // what core produces today: lines that start together leave a zero-length caption the server refuses
    expect(captions(generated).some((c) => c.duration <= 0)).toBe(true)
    const fixed = captionsAtLeastOneFrame(generated)
    expect(captions(fixed)).toHaveLength(captions(generated).length)
    expect(captions(fixed).every((c) => c.duration >= 1 / p.fps)).toBe(true)
  })

  it('leaves a project with no short captions untouched', () => {
    const p = generateCaptions(twoVoices(), { style: captionStyleFromPreset('clean') })
    expect(captionsAtLeastOneFrame(p)).toBe(p)
  })
})
