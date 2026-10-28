// Producer AI (A-7): the script's versions with Restore, a scene's own narrator and "Narrate again", footage picked on
// the video, Assemble into a copy whenever a video was assembled, and time estimates before and during each step.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Job, ScriptScene, ScriptVersion, Voice, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { brandApi } from '../../lib/brandApi'
import { useSession } from '../../lib/session'
import { estimateAssemble, estimateWrite, formatEstimate, remainingSeconds } from '../producer/estimates'
import { FootagePicker, clampWindow } from '../producer/FootagePicker'
import ProducerWizard from '../producer/ProducerWizard'
import { NarratorControl, producerApi } from '../producer/sceneTools'
import { initialState, type WizardState } from '../producer/wizardLogic'
import { markDraftSaved, runAssemble, useWizard } from '../producer/wizardStore'

vi.setConfig({ testTimeout: 120_000 })

const team: Workspace = { id: 'ws_a', name: 'Team A', role: 'editor', personal: false, memberCount: 3 }
const scene = (id: string, over: Partial<ScriptScene> = {}): ScriptScene => ({ id, title: id, headline: `Headline ${id}`, narration: `Narration for ${id} with a few more words`, footage: [], ...over })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const job = (over: Partial<Job> = {}): Job<any> => ({ id: 'j1', kind: 'ai.produce.assemble', status: 'done', progress: 1, message: 'Done', workspaceId: 'ws_a', projectId: 'p1', result: { version: 4 }, createdAt: 0, updatedAt: 0, ...over })
const voices: Voice[] = [{ id: 'af_heart', name: 'Heart', lang: 'American English', gender: 'female', style: 'Warm' }, { id: 'am_eric', name: 'Eric', lang: 'American English', gender: 'male', style: 'Confident' }]

function wizard(over: Partial<WizardState> = {}): WizardState {
  const base = initialState()
  return { ...base, projectId: 'p1', workspaceId: 'ws_a', step: 'review', scenes: [scene('s01'), scene('s02')], brief: { ...base.brief, title: 'Spring tour', template: 'studio-dark' }, draft: { state: 'saved' }, ...over }
}
function load(s: WizardState) {
  markDraftSaved(s)
  useWizard.getState().replace(s)
}
const st = () => useWizard.getState().s
const show = () =>
  render(
    <MemoryRouter initialEntries={['/producer/p1']}>
      <Routes>
        <Route path="/producer/:projectId" element={<ProducerWizard />} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  sessionStorage.clear()
  useSession.setState({ status: 'ready', workspaces: [team], workspaceId: 'ws_a' })
  vi.spyOn(api, 'templates').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue(voices)
  vi.spyOn(api, 'brand').mockResolvedValue({ name: 'A', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
  vi.spyOn(api, 'saveProducerDraft').mockResolvedValue({ version: 9 })
  vi.spyOn(api, 'job').mockImplementation(async () => job())
  vi.spyOn(api, 'project').mockRejectedValue(new Error('not in this test'))
  vi.spyOn(brandApi, 'kits').mockResolvedValue({ items: [] })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('time estimates', () => {
  it('estimate writing from what still needs transcribing, and assembly from narration, reused voices and visuals', () => {
    const rec = { localId: 'a', assetId: 'as_1', name: 'tour.mp4', size: 1, status: 'ready' as const, progress: 1, duration: 240 }
    const s = wizard({ assets: [rec], transcribed: [] })
    expect(estimateWrite(s)).toBe(8 + 60 + 20 + 16)
    expect(estimateWrite({ ...s, transcribed: ['as_1'] })).toBe(36)
    expect(estimateWrite(wizard({ brief: { ...s.brief, source: 'idea' } }))).toBe(30)
    const fresh = estimateAssemble([scene('s01'), scene('s02', { visual: { kind: 'aiVideo', prompt: 'x' } as never })])
    const voiced = estimateAssemble([scene('s01', { voice: { assetId: 'v', duration: 3 } }), scene('s02', { visual: { kind: 'aiVideo', prompt: 'x' } as never })])
    expect(fresh).toBeGreaterThan(voiced)
    expect(fresh).toBeGreaterThan(120)
    expect(estimateAssemble([scene('s01', { voice: { assetId: 'v', duration: 3 } })], { renarrate: ['s01'] })).toBeGreaterThan(estimateAssemble([scene('s01', { voice: { assetId: 'v', duration: 3 } })]))
    expect(formatEstimate(30)).toBe('less than a minute')
    expect(formatEstimate(70)).toBe('about a minute')
    expect(formatEstimate(200)).toBe('about 3 minutes')
    expect(remainingSeconds(100, 0.75)).toBe(25)
    expect(remainingSeconds(100, undefined)).toBe(100)
  })
})

describe('the review step', () => {
  it('lists the script’s versions and restores one into the wizard', async () => {
    const older: ScriptVersion = { versionId: 'pv_1', version: 3, createdAt: Date.now() - 3600_000, label: 'autosave', authorName: 'Kim', scenes: [scene('s01', { narration: 'The older hook' })], words: 3 }
    const latest: ScriptVersion = { ...older, versionId: 'pv_2', version: 5, createdAt: Date.now(), scenes: wizard().scenes, words: 16 }
    vi.spyOn(producerApi, 'scriptVersions').mockResolvedValue([latest, older])
    load(wizard())
    show()
    fireEvent.click(await screen.findByRole('button', { name: /Versions/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Script versions' })
    const rows = await within(dialog).findAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[1].textContent).toMatch(/1 scene · 3 words · Kim/)
    // the latest is what's on screen: nothing to restore there
    expect(within(rows[0]).queryByRole('button')).toBeNull()
    fireEvent.click(within(rows[1]).getByRole('button', { name: /Restore the script from/ }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Script versions' })).toBeNull())
    expect(st().scenes.map((s) => s.narration)).toEqual(['The older hook'])
  })

  it('a scene can have its own narrator, and an assembled one can be narrated again on its own', async () => {
    const assemble = vi.spyOn(api, 'produceAssemble').mockResolvedValue(job({ status: 'queued' }))
    load(wizard({ scenes: [scene('s01', { voice: { assetId: 'v1', duration: 3 } }), scene('s02')] }))
    show()
    const btns = await screen.findAllByRole('button', { name: /^Narrator of this scene: Heart/ })
    expect(btns).toHaveLength(2)
    fireEvent.click(btns[0])
    fireEvent.change(await screen.findByLabelText('Voice for this scene'), { target: { value: 'am_eric' } })
    expect(st().scenes[0].narrator).toEqual({ voice: 'am_eric' })
    fireEvent.click(screen.getByRole('button', { name: /Narrate again/ }))
    await waitFor(() => expect(assemble).toHaveBeenCalledWith(expect.objectContaining({ renarrate: ['s01'], scenes: expect.arrayContaining([expect.objectContaining({ id: 's01', narrator: { voice: 'am_eric' } })]) })))
    // a scene not assembled yet has no Narrate again
    cleanup()
    render(<NarratorControl scene={scene('s09')} voices={voices} briefVoice="af_heart" assembled={false} onChange={() => undefined} onRenarrate={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /Narrator of this scene/ }))
    expect(screen.queryByRole('button', { name: /Narrate again/ })).toBeNull()
  })

  it('picks a footage window on the video: scrub, then set the start and end there', () => {
    const onChange = vi.fn()
    render(<FootagePicker assetId="as_1" name="tour.mp4" duration={30} start={2} end={6} onChange={onChange} />)
    const scrub = screen.getByRole('slider', { name: 'Scrub tour.mp4' })
    fireEvent.change(scrub, { target: { value: '12.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start here' }))
    expect(onChange).toHaveBeenLastCalledWith({ start: 12.5, end: 13 })
    fireEvent.change(scrub, { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'End here' }))
    expect(onChange).toHaveBeenLastCalledWith({ start: 2, end: 4 })
    fireEvent.keyDown(scrub, { key: 'ArrowRight', shiftKey: true })
    expect((scrub as HTMLInputElement).value).toBe('5')
    expect(clampWindow(29.8, 31, 30)).toEqual({ start: 29.8, end: 30 })
    expect(clampWindow(5, 3, 30)).toEqual({ start: 5, end: 5.5 })
  })
})

describe('the assemble step', () => {
  it('offers Assemble into a copy once a video was assembled, and says how long it should take', async () => {
    const assemble = vi.spyOn(api, 'produceAssemble').mockResolvedValue(job({ status: 'queued' }))
    load(wizard({ step: 'assemble', scenes: [scene('s01', { voice: { assetId: 'v1', duration: 3 } })] }))
    show()
    expect(await screen.findByText(/This usually takes (less than a minute|about)/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Assemble into a copy/ }))
    await waitFor(() => expect(assemble).toHaveBeenCalledWith(expect.objectContaining({ intoCopy: true })))
    await act(async () => {
      await runAssemble()
    })
    // and after it's done, again
    await waitFor(() => expect(st().run).toMatchObject({ status: 'done', phase: 'assemble' }))
    expect(screen.getByRole('button', { name: /Assemble into a copy/ })).toBeTruthy()
  })

  it('a project never assembled has just Assemble video', async () => {
    load(wizard({ step: 'assemble' }))
    show()
    await screen.findByRole('button', { name: /Assemble video/ })
    expect(screen.queryByRole('button', { name: /Assemble into a copy/ })).toBeNull()
  })
})
