// Producer AI wizard: work is never lost. Assemble uses the brief as it is now (APP-3), Review edits are saved to the
// project (APP-5), the wizard stays in its own space (APP-6), and re-assembling over edits asks first (APP-7).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AssetRecord, Job, ScriptScene, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, HttpError } from '../../lib/api'
import { useSession } from '../../lib/session'
import ProducerWizard from '../producer/ProducerWizard'
import { canAdvance, initialState, sanitizeForResume, staleBriefFields, wizardWorkspace, type WizardState } from '../producer/wizardLogic'
import { addLibraryAssets, markDraftSaved, resumeDraft, runAssemble, uploadToWizard, useWizard } from '../producer/wizardStore'

// the first render of the whole wizard is slow on a cold module graph
vi.setConfig({ testTimeout: 30_000 })

const teamA: Workspace ={ id: 'ws_a', name: 'Team A', role: 'editor', personal: false, memberCount: 3 }
const teamB: Workspace = { id: 'ws_b', name: 'Team B', role: 'editor', personal: false, memberCount: 2 }
const scene = (id: string, over: Partial<ScriptScene> = {}): ScriptScene => ({ id, title: id, headline: `Headline ${id}`, narration: `Narration for ${id}`, footage: [], ...over })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const job = (over: Partial<Job> = {}): Job<any> => ({ id: 'j1', kind: 'ai.produce.assemble', status: 'done', progress: 1, message: 'Done', workspaceId: 'ws_a', projectId: 'p1', result: { version: 4 }, createdAt: 0, updatedAt: 0, ...over })
const rec = (id: string): AssetRecord => ({ asset: { id, kind: 'video', name: `${id}.mp4`, src: '', duration: 12 }, status: 'ready', workspaceId: 'ws_a', origin: 'upload', createdAt: 0, updatedAt: 0 }) as unknown as AssetRecord

function wizard(over: Partial<WizardState> = {}): WizardState {
  const base = initialState()
  return { ...base, projectId: 'p1', workspaceId: 'ws_a', step: 'review', scenes: [scene('s01'), scene('s02')], brief: { ...base.brief, title: 'Spring tour', template: 'studio-dark' }, draft: { state: 'saved' }, ...over }
}
function load(s: WizardState) {
  markDraftSaved(s)
  useWizard.getState().replace(s)
}
const st = () => useWizard.getState().s

function show(path = '/producer/p1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/producer/:projectId" element={<ProducerWizard />} />
        <Route path="/producer/new" element={<ProducerWizard />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  sessionStorage.clear()
  useSession.setState({ status: 'ready', workspaces: [teamA, teamB], workspaceId: 'ws_a' })
  vi.spyOn(api, 'templates').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue([])
  vi.spyOn(api, 'brand').mockResolvedValue({ name: 'A', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
  vi.spyOn(api, 'saveProducerDraft').mockResolvedValue({ version: 9 })
  vi.spyOn(api, 'job').mockImplementation(async () => job())
  vi.spyOn(api, 'project').mockRejectedValue(new Error('not in this test'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Assemble uses the brief as it is now (APP-3)', () => {
  it('sends the current voice, look and title with Assemble', async () => {
    load(wizard({ brief: { ...wizard().brief, voice: 'am_eric', template: 'clean-light', title: 'Autumn tour' } }))
    const assemble = vi.spyOn(api, 'produceAssemble').mockResolvedValue(job({ status: 'queued' }))
    await runAssemble()
    expect(assemble).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', scenes: st().scenes, brief: expect.objectContaining({ voice: 'am_eric', template: 'clean-light', title: 'Autumn tour' }) }))
    expect(st().run).toMatchObject({ status: 'done', phase: 'assemble' })
  })

  it('a brief changed in ways only the writer reads marks the script stale until rewritten or kept', async () => {
    const s = wizard({ scriptBrief: { ...wizard().brief, tone: 'Calm' }, brief: { ...wizard().brief, tone: 'Playful' } })
    expect(staleBriefFields(s)).toEqual(['tone'])
    expect(canAdvance(s)).toEqual({ ok: false, reason: 'Rewrite the script or keep it first' })
    // voice and look are used as they are: nothing stale
    expect(staleBriefFields({ ...s, brief: { ...s.scriptBrief!, voice: 'am_eric', template: 'other' } })).toEqual([])
    load(s)
    show()
    expect(screen.getByText(/The brief changed after this script was written/)).toBeTruthy()
    expect((screen.getByRole('button', { name: /Assemble video/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Keep this script' }))
    expect(screen.queryByText(/The brief changed after this script was written/)).toBeNull()
    expect((screen.getByRole('button', { name: /Assemble video/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('Review edits are saved to the project (APP-5)', () => {
  it('saves the script shortly after typing and shows Saved', async () => {
    vi.useFakeTimers()
    const save = vi.mocked(api.saveProducerDraft)
    load(wizard())
    useWizard.getState().patch((s) => ({ scenes: [{ ...s.scenes[0], narration: 'Edited on the Review step.' }, s.scenes[1]] }))
    expect(st().draft?.state).toBe('pending')
    await vi.advanceTimersByTimeAsync(900)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toMatchObject({ projectId: 'p1', brief: { title: 'Spring tour' }, scenes: [{ narration: 'Edited on the Review step.' }, { id: 's02' }] })
    expect(st().draft?.state).toBe('saved')
    // nothing new: nothing sent
    useWizard.getState().patch((s) => ({ scenes: [...s.scenes] }))
    await vi.advanceTimersByTimeAsync(900)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('says when a save failed, and Retry sends it', async () => {
    vi.useFakeTimers()
    const save = vi.mocked(api.saveProducerDraft).mockRejectedValueOnce(new HttpError(500, { error: 'Database unavailable' }))
    load(wizard())
    useWizard.getState().patch((s) => ({ brief: { ...s.brief, title: 'Renamed' } }))
    await vi.advanceTimersByTimeAsync(900)
    expect(st().draft).toEqual({ state: 'error', error: 'Database unavailable' })
    vi.useRealTimers()
    show()
    expect(screen.getByText(/Not saved: Database unavailable/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy())
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('never saves over the script while a job is writing it', async () => {
    vi.useFakeTimers()
    load(wizard({ run: { status: 'running', phase: 'assemble' } }))
    useWizard.getState().patch((s) => ({ scenes: [{ ...s.scenes[0], narration: 'x' }] }))
    await vi.advanceTimersByTimeAsync(900)
    expect(api.saveProducerDraft).not.toHaveBeenCalled()
  })

  it('a tab reloaded with edits that never reached the project sends them', async () => {
    vi.useFakeTimers()
    const s = sanitizeForResume(wizard({ scenes: [scene('s01', { narration: 'Typed before the tab closed' })], draft: { state: 'saving' } }))
    useWizard.getState().replace(s)
    await resumeDraft()
    await vi.advanceTimersByTimeAsync(10)
    expect(api.saveProducerDraft).toHaveBeenCalledWith(expect.objectContaining({ scenes: [expect.objectContaining({ narration: 'Typed before the tab closed' })] }))
  })
})

describe('the wizard stays in its own space (APP-6)', () => {
  it('uploads and library picks bind a new draft to their space', async () => {
    useWizard.getState().replace(initialState())
    expect(wizardWorkspace(st(), 'ws_b')).toBe('ws_b')
    vi.spyOn(api, 'upload').mockResolvedValue(rec('as_up'))
    await uploadToWizard('ws_a', [new File(['x'], 'rec.mp4', { type: 'video/mp4' })])
    expect(st().workspaceId).toBe('ws_a')
    useWizard.getState().replace(initialState())
    addLibraryAssets([rec('as_lib')], 'ws_a')
    expect(st().workspaceId).toBe('ws_a')
  })

  it('after a switch elsewhere, uploads and the library still use the video’s space, and it offers to switch back', async () => {
    load(wizard({ step: 'upload', scenes: [] }))
    useSession.setState({ workspaceId: 'ws_b' })
    const assets = vi.spyOn(api, 'assets').mockResolvedValue([rec('as_1')])
    const upload = vi.spyOn(api, 'upload').mockResolvedValue(rec('as_up'))
    show()
    expect(screen.getByRole('alert').textContent).toMatch(/belongs to Team A, and you switched to Team B/)
    fireEvent.click(screen.getByRole('button', { name: /From library/ }))
    await waitFor(() => expect(assets).toHaveBeenCalledWith('ws_a', 'video'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // the hidden file input behind "Choose files"
    const input = [...document.body.querySelectorAll('input[type=file]')].find((i) => (i as HTMLInputElement).accept === 'video/*') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'more.mp4', { type: 'video/mp4' })] })
    fireEvent.change(input)
    await waitFor(() => expect(upload).toHaveBeenCalled())
    expect(upload.mock.calls[0][0]).toBe('ws_a')
    fireEvent.click(screen.getByRole('button', { name: 'Switch back to Team A' }))
    expect(useSession.getState().workspaceId).toBe('ws_a')
    expect(screen.queryByText(/you switched to/)).toBeNull()
  })

  it('or starts a new video in the space switched to', async () => {
    load(wizard({ step: 'upload', scenes: [] }))
    useSession.setState({ workspaceId: 'ws_b' })
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Start a new video in Team B' }))
    expect(st().projectId).toBeUndefined()
    expect(wizardWorkspace(st(), 'ws_b')).toBe('ws_b')
    expect(screen.queryByText(/you switched to/)).toBeNull()
  })
})

describe('re-assembling over edits asks first (APP-7)', () => {
  const edited = () => new HttpError(409, { error: 'This project was edited since it was assembled. Assembling again replaces the whole timeline, including those edits.', code: 'conflict', details: { reason: 'edited' } })

  it('asks, then assembles into a copy the wizard follows', async () => {
    load(wizard())
    const assemble = vi.spyOn(api, 'produceAssemble').mockRejectedValueOnce(edited()).mockResolvedValueOnce(job({ status: 'queued', projectId: 'p_copy' }))
    vi.mocked(api.job).mockResolvedValue(job({ projectId: 'p_copy' }))
    await runAssemble()
    expect(st().run).toMatchObject({ status: 'idle', confirm: 'edited' })
    const opened: string[] = []
    await runAssemble({ intoCopy: true, onProject: (id) => opened.push(id) })
    expect(assemble.mock.calls[1][0]).toMatchObject({ projectId: 'p1', intoCopy: true })
    expect(opened).toEqual(['p_copy'])
    expect(st()).toMatchObject({ projectId: 'p_copy', run: { status: 'done', phase: 'assemble' } })
    expect(api.project).toHaveBeenCalledWith('p_copy')
  })

  it('shows the choice, and Replace sends replace', async () => {
    load(wizard({ step: 'assemble', run: { status: 'idle', phase: 'assemble', confirm: 'edited', message: 'This project was edited since it was assembled.' } }))
    const assemble = vi.spyOn(api, 'produceAssemble').mockResolvedValue(job({ status: 'queued' }))
    show()
    expect(screen.getByRole('heading', { name: 'This video was edited since it was assembled' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Assemble into a copy/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Replace the timeline/ }))
    await waitFor(() => expect(assemble).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', replace: true })))
  })
})
