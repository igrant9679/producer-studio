// Captions from the Captions panel: built on the project as it is after transcribing, never shorter than a frame.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addAsset, addItem, captionStyleFromPreset, createAudioItem, createProject, generateCaptions, updateProject, type Asset, type Job, type Project } from '@producer/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { captionsAtLeastOneFrame } from '../actions'
import { CaptionsPanel } from '../panels/CaptionsPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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

describe('auto captions after transcribing', { timeout: 20_000 }, () => {
  it('builds captions on the project as it is when the transcript arrives, keeping edits made meanwhile', async () => {
    const { transcript, ...untranscribed } = voice
    let p = addAsset(createProject({ id: 'p1', name: 'Captions' }), untranscribed)
    p = addItem(p, createAudioItem(untranscribed, 0))
    S().load({ project: p, version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
    vi.spyOn(api, 'transcribe').mockResolvedValue({ id: 'j1', status: 'queued' } as Job<never>)
    let finish!: (j: Job) => void
    vi.spyOn(api, 'job').mockReturnValue(new Promise<Job>((r) => (finish = r)) as never)

    render(<CaptionsPanel />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Generate captions/ })))
    // you keep editing while the clip is transcribed
    S().commit(updateProject(S().project, { background: '#223344' }), 'Background')
    await act(async () => finish({ id: 'j1', status: 'done', progress: 1, result: { assetId: voice.id, transcript } } as unknown as Job))

    expect(S().project.background).toBe('#223344')
    expect(S().project.assets[voice.id].transcript).toEqual(transcript)
    expect(captions(S().project).map((c) => (c as { text: string }).text).join(' ')).toBe('Hello there')
    // the transcript is a media record, not a step: undo removes the captions only
    expect(S().history.past.map((h) => h.label)).toEqual(['Background', 'Auto captions'])
    S().undo()
    expect(captions(S().project)).toHaveLength(0)
    expect(S().project.assets[voice.id].transcript).toEqual(transcript)
    expect(S().project.background).toBe('#223344')
  })
})
