// Producer AI wizard: coming back to a script or a video that was being made when the tab went away. The wizard says
// "You can leave this page: it keeps going", and the job does keep going on the server, so on the way back the wizard
// asks about that job instead of calling it interrupted: still going → followed again; finished → finished; failed →
// its reason. Nothing is started that wasn't already, and a job is never started a second time.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Job, ScriptScene, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, HttpError } from '../../lib/api'
import { useSession } from '../../lib/session'
import ProducerWizard from '../producer/ProducerWizard'
import { initialState, sanitizeForResume, storageKey, type WizardState } from '../producer/wizardLogic'
import { FOLLOW, followActiveJob, resumeRun, runAssemble, useWizard } from '../producer/wizardStore'

// the first render of the whole wizard is slow on a cold module graph
vi.setConfig({ testTimeout: 30_000 })

const team: Workspace = { id: 'ws_a', name: 'Team A', role: 'editor', personal: false, memberCount: 3 }
const scene = (id: string, over: Partial<ScriptScene> = {}): ScriptScene => ({ id, title: id, headline: `Headline ${id}`, narration: `Narration for ${id}`, footage: [], ...over })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const job = (over: Partial<Job> = {}): Job<any> => ({ id: 'j7', kind: 'ai.produce.assemble', status: 'done', progress: 1, message: 'Done', workspaceId: 'ws_a', projectId: 'p1', result: { version: 6 }, createdAt: 0, updatedAt: 0, ...over })

function wizard(over: Partial<WizardState> = {}): WizardState {
  const base = initialState()
  return { ...base, projectId: 'p1', workspaceId: 'ws_a', step: 'assemble', scenes: [scene('s01'), scene('s02')], brief: { ...base.brief, title: 'Spring tour', template: 'studio-dark' }, draft: { state: 'saved' }, ...over }
}
/** The tab went away while this was on screen: what a reload finds in the tab's storage. */
const assembling = (): WizardState => wizard({ run: { status: 'running', phase: 'assemble', jobId: 'j7', message: 'Drawing s02', progress: 0.7 } })
/** The same, as the wizard loads it back. */
const back = (s: WizardState) => useWizard.getState().replace(sanitizeForResume(s))
const st = () => useWizard.getState().s

function show(path = '/producer/p1?step=assemble') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/producer/:projectId" element={<ProducerWizard />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useWizard.getState().replace(initialState())
  sessionStorage.clear()
  useSession.setState({ status: 'ready', workspaces: [team], workspaceId: 'ws_a' })
  vi.spyOn(api, 'templates').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue([])
  vi.spyOn(api, 'brand').mockResolvedValue({ name: 'A', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
  vi.spyOn(api, 'saveProducerDraft').mockResolvedValue({ version: 9 })
  vi.spyOn(api, 'job').mockImplementation(async (id: string) => job({ id }))
  vi.spyOn(api, 'project').mockRejectedValue(new Error('not in this test'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  FOLLOW.patienceMs = 3 * 60_000
})

describe('coming back to a video that was being assembled', () => {
  it('one that finished meanwhile is shown as ready, never as interrupted, and assembling again is a new assembly', async () => {
    sessionStorage.setItem(storageKey('p1'), JSON.stringify(assembling()))
    const assemble = vi.spyOn(api, 'produceAssemble').mockResolvedValue(job({ id: 'j8', status: 'queued' }))
    let answer!: (j: Job) => void
    vi.mocked(api.job).mockImplementationOnce(() => new Promise((r) => (answer = r as (j: Job) => void)))
    show()
    // while the server is being asked: it is checking, not interrupted
    expect(screen.getByRole('heading', { name: 'Assembling your video' })).toBeTruthy()
    expect(screen.getByText('Checking on your video…')).toBeTruthy()
    expect(screen.queryByText(/interrupted/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull()
    expect(api.job).toHaveBeenCalledWith('j7')
    answer(job({ result: { version: 6, notes: ['s02: a picture stands in for the clip.'] } }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Your video is ready' })).toBeTruthy())
    expect(screen.getByText('s02: a picture stands in for the clip.')).toBeTruthy()
    expect(screen.queryByText(/interrupted/i)).toBeNull()
    expect(st()).toMatchObject({ assembledVersion: 6, run: { status: 'done', phase: 'assemble' } })
    expect(st().run.jobId).toBeUndefined()
    expect(assemble).not.toHaveBeenCalled()
    // back to the script and Assemble video: a new assembly, not the finished one picked up again
    fireEvent.click(screen.getByRole('button', { name: 'Back to script' }))
    fireEvent.click(await screen.findByRole('button', { name: /Assemble video/ }))
    await waitFor(() => expect(assemble).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(st().run).toMatchObject({ status: 'done', phase: 'assemble' }))
    expect(vi.mocked(api.job).mock.calls.map((c) => c[0])).toContain('j8')
  })

  it('one still going is followed again with its progress, and no second assembly is started', async () => {
    vi.useFakeTimers()
    const assemble = vi.spyOn(api, 'produceAssemble')
    const polls = [job({ status: 'running', progress: 0.7, message: 'Drawing s02: Checking the frames' }), job({ status: 'running', progress: 0.85, message: 'Drawing s03: Rendering' }), job({ result: { version: 6 } })]
    vi.mocked(api.job).mockImplementation(async () => polls.shift() ?? job())
    back(assembling())
    const run = resumeRun()
    expect(st().run).toMatchObject({ status: 'running', phase: 'assemble', message: 'Checking on your video…' })
    await vi.advanceTimersByTimeAsync(10)
    expect(st().run).toMatchObject({ status: 'running', jobId: 'j7', progress: 0.7, message: 'Drawing s02: Checking the frames' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(st().run).toMatchObject({ status: 'running', progress: 0.85, message: 'Drawing s03: Rendering' })
    await vi.advanceTimersByTimeAsync(1000)
    await run
    expect(st()).toMatchObject({ assembledVersion: 6, run: { status: 'done', phase: 'assemble', message: 'Your video is ready' } })
    expect(assemble).not.toHaveBeenCalled()
  })

  it('one that failed meanwhile says why, and Try again is a new assembly', async () => {
    vi.mocked(api.job).mockImplementation(async (id: string) => (id === 'j7' ? job({ status: 'error', error: 'Your AI key has run out of credit.' }) : job({ id })))
    back(assembling())
    await resumeRun()
    expect(st().run).toMatchObject({ status: 'error', phase: 'assemble', error: 'Your AI key has run out of credit.' })
    const assemble = vi.spyOn(api, 'produceAssemble').mockResolvedValue(job({ id: 'j8', status: 'queued' }))
    await runAssemble()
    expect(assemble).toHaveBeenCalledTimes(1)
    expect(st().run).toMatchObject({ status: 'done', phase: 'assemble' })
  })

  it('one that somebody stopped is not a failure: the video can simply be assembled', async () => {
    vi.mocked(api.job).mockResolvedValue(job({ status: 'cancelled' }))
    back(assembling())
    await resumeRun()
    expect(st().run).toMatchObject({ status: 'idle', message: 'Stopped' })
    expect(st().run.interrupted).toBeFalsy()
    expect(st().run.jobId).toBeUndefined()
    expect(st().run.error).toBeUndefined()
  })

  it.each([
    ['the network is down', () => new TypeError('Failed to fetch')],
    ['the server is restarting', () => new HttpError(503, { error: 'Service unavailable' })],
  ])('when it can’t be asked about (%s) it stays the same job to resume, never a second one', async (_why, failure) => {
    // (the three minutes it would keep asking are over)
    FOLLOW.patienceMs = 0
    const assemble = vi.spyOn(api, 'produceAssemble')
    vi.mocked(api.job).mockRejectedValueOnce(failure())
    back(assembling())
    await resumeRun()
    expect(st().run).toMatchObject({ status: 'idle', phase: 'assemble', interrupted: true, jobId: 'j7' })
    show()
    expect(screen.getByText('Couldn’t check on your video just now. Resume to pick it up where it is.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Your video is ready' })).toBeTruthy())
    expect(vi.mocked(api.job).mock.calls.every((c) => c[0] === 'j7')).toBe(true)
    expect(assemble).not.toHaveBeenCalled()
  })

  it('a job the server no longer knows leaves nothing to pick up', async () => {
    vi.mocked(api.job).mockRejectedValue(new HttpError(404, { error: 'Not found' }))
    back(assembling())
    await resumeRun()
    expect(st().run).toEqual({ status: 'idle', phase: 'assemble' })
  })

  it('a run that wasn’t left behind is left alone', () => {
    back(wizard({ run: { status: 'done', phase: 'assemble', message: 'Your video is ready' } }))
    expect(resumeRun()).toBeUndefined()
    back(wizard({ step: 'review', run: { status: 'idle' } }))
    expect(resumeRun()).toBeUndefined()
    expect(api.job).not.toHaveBeenCalled()
  })
})

describe('one assembly of a video at a time', () => {
  /** On the review step, nothing running: about to press Assemble video. */
  const ready = () => useWizard.getState().replace(wizard({ step: 'review', run: { status: 'idle' } }))

  it('a status check that fails for a moment is asked again: the job goes on, and nothing is started twice', async () => {
    vi.useFakeTimers()
    ready()
    const assemble = vi.spyOn(api, 'produceAssemble').mockResolvedValue(job({ id: 'j1', status: 'queued' }))
    const polls: Array<() => Promise<Job>> = [
      async () => job({ id: 'j1', status: 'running', progress: 0.3, message: 'Voicing s02' }),
      // the network drops, then the server is restarting behind its gateway (a deploy)
      async () => Promise.reject(new TypeError('Failed to fetch')),
      async () => Promise.reject(new HttpError(502, { error: 'Bad gateway' })),
      async () => job({ id: 'j1', status: 'running', progress: 0.7, message: 'Drawing s01: Writing the animation' }),
      async () => job({ id: 'j1', result: { version: 6 } }),
    ]
    vi.mocked(api.job).mockImplementation(() => (polls.shift() ?? (async () => job({ id: 'j1' })))())
    const run = runAssemble()
    await vi.advanceTimersByTimeAsync(10)
    expect(st().run).toMatchObject({ status: 'running', jobId: 'j1', progress: 0.3, message: 'Voicing s02' })
    await vi.advanceTimersByTimeAsync(1000)
    // still running, and the page says what is going on instead of "Assembly failed"
    expect(st().run).toMatchObject({ status: 'running', jobId: 'j1', message: 'Lost the connection to the server: trying again…' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(st().run).toMatchObject({ status: 'running', jobId: 'j1' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(st().run).toMatchObject({ status: 'running', progress: 0.7, message: 'Drawing s01: Writing the animation' })
    await vi.advanceTimersByTimeAsync(1000)
    await run
    expect(st()).toMatchObject({ assembledVersion: 6, run: { status: 'done', phase: 'assemble' } })
    expect(assemble).toHaveBeenCalledTimes(1)
  })

  it('when the server stays out of reach, a run started here becomes Resume on the same job, not “failed, try again”', async () => {
    FOLLOW.patienceMs = 0
    ready()
    const assemble = vi.spyOn(api, 'produceAssemble').mockResolvedValue(job({ id: 'j1', status: 'queued' }))
    vi.mocked(api.job).mockRejectedValueOnce(new HttpError(503, { error: 'Service unavailable' }))
    await runAssemble()
    expect(st().run).toMatchObject({ status: 'idle', phase: 'assemble', interrupted: true, jobId: 'j1' })
    expect(st().run.error).toBeUndefined()
    // pressing the button again asks about the same job; the assembly is not asked for a second time
    await runAssemble()
    expect(vi.mocked(api.job).mock.calls.every((c) => c[0] === 'j1')).toBe(true)
    expect(assemble).toHaveBeenCalledTimes(1)
    expect(st().run).toMatchObject({ status: 'done', phase: 'assemble' })
  })

  it('a job that really failed is still a failure, with its reason', async () => {
    ready()
    vi.spyOn(api, 'produceAssemble').mockResolvedValue(job({ id: 'j1', status: 'queued' }))
    vi.mocked(api.job).mockResolvedValue(job({ id: 'j1', status: 'error', error: 'Producer AI made no progress for 20 minutes and was stopped. Try again.' }))
    await runAssemble()
    expect(st().run).toMatchObject({ status: 'error', error: 'Producer AI made no progress for 20 minutes and was stopped. Try again.' })
    expect(st().run.interrupted).toBeFalsy()
  })

  it('told that the video is already being assembled, the wizard follows that job', async () => {
    ready()
    const assemble = vi.spyOn(api, 'produceAssemble').mockRejectedValue(new HttpError(409, { error: 'This video is already being assembled.', code: 'conflict', details: { reason: 'assembling', jobId: 'j_other' } }))
    vi.mocked(api.job).mockImplementation(async (id: string) => job({ id, result: { version: 8 } }))
    await runAssemble({ replace: true })
    expect(assemble).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.job).mock.calls.map((c) => c[0])).toEqual(['j_other'])
    expect(st()).toMatchObject({ step: 'assemble', assembledVersion: 8, run: { status: 'done', phase: 'assemble' } })
  })

  it('a wizard opened on a video that is being assembled elsewhere follows that job', async () => {
    ready()
    const assemble = vi.spyOn(api, 'produceAssemble')
    const jobs = vi.spyOn(api, 'jobs').mockResolvedValue([
      job({ id: 'j_export', kind: 'export.render', status: 'running', createdAt: 9 }),
      job({ id: 'j_old', status: 'done', createdAt: 1 }),
      job({ id: 'j9', status: 'running', createdAt: 5 }),
    ])
    await followActiveJob({ workspaceId: 'ws_a' })
    expect(jobs).toHaveBeenCalledWith({ projectId: 'p1' })
    expect(vi.mocked(api.job).mock.calls.map((c) => c[0])).toEqual(['j9'])
    expect(st()).toMatchObject({ step: 'assemble', run: { status: 'done', phase: 'assemble' } })
    expect(assemble).not.toHaveBeenCalled()
  })

  it('…and one whose script is being written follows the writing', async () => {
    useWizard.getState().replace(wizard({ step: 'brief', scenes: [], run: { status: 'idle' } }))
    const script = vi.spyOn(api, 'produceScript')
    vi.spyOn(api, 'jobs').mockResolvedValue([job({ id: 'j_script', kind: 'ai.produce.script', status: 'queued' })])
    vi.mocked(api.job).mockImplementation(async (id: string) => job({ id, kind: 'ai.produce.script', result: { script: { scenes: [scene('s01'), scene('s02')] } } }))
    await followActiveJob({ workspaceId: 'ws_a' })
    expect(script).not.toHaveBeenCalled()
    expect(st()).toMatchObject({ step: 'review', run: { status: 'done', phase: 'script' } })
    expect(st().scenes).toHaveLength(2)
  })

  it('nothing at work, a question that fails, or a run already being followed: nothing changes', async () => {
    ready()
    const before = st()
    const jobs = vi.spyOn(api, 'jobs').mockResolvedValue([job({ id: 'j_old', status: 'done' }), job({ id: 'j_stopped', status: 'cancelled' }), job({ id: 'j_failed', status: 'error' })])
    await followActiveJob({ workspaceId: 'ws_a' })
    expect(st()).toBe(before)
    jobs.mockRejectedValue(new TypeError('Failed to fetch'))
    await followActiveJob({ workspaceId: 'ws_a' })
    expect(st()).toBe(before)
    expect(api.job).not.toHaveBeenCalled()
    // a run this tab already has (running, or waiting to be resumed) is not asked about at all
    jobs.mockClear()
    useWizard.getState().replace(wizard({ run: { status: 'running', phase: 'assemble', jobId: 'j7' } }))
    await followActiveJob({ workspaceId: 'ws_a' })
    back(assembling())
    await followActiveJob({ workspaceId: 'ws_a' })
    expect(jobs).not.toHaveBeenCalled()
  })

  it('a fresh tab (nothing in its storage) shows the assembly that is under way, and its end', async () => {
    const assemble = vi.spyOn(api, 'produceAssemble')
    const doc = { project: { id: 'p1', name: 'Spring tour', assets: {}, tracks: [], ai: { brief: wizard().brief, script: { scenes: [scene('s01'), scene('s02')] }, status: 'scripted' } }, summary: { id: 'p1', name: 'Spring tour', workspaceId: 'ws_a', kind: 'producer' }, version: 3 }
    vi.mocked(api.project).mockResolvedValue(doc as never)
    vi.spyOn(api, 'jobs').mockResolvedValue([job({ id: 'j9', status: 'running', progress: 0.7 })])
    let finished = false
    vi.mocked(api.job).mockImplementation(async (id: string) => (finished ? job({ id, result: { version: 4 } }) : job({ id, status: 'running', progress: 0.7, message: 'Drawing s02: Writing the animation (2 min)' })))
    show('/producer/p1')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Assembling your video' })).toBeTruthy())
    expect(await screen.findByText('Drawing s02: Writing the animation (2 min)')).toBeTruthy()
    expect(vi.mocked(api.job).mock.calls.every((c) => c[0] === 'j9')).toBe(true)
    // there is a Stop, and no button that would start it again
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Assemble video/ })).toBeNull()
    finished = true
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Your video is ready' })).toBeTruthy(), { timeout: 5000 })
    expect(assemble).not.toHaveBeenCalled()
  })
})

describe('coming back to a script that was being written', () => {
  const writing = (): WizardState => wizard({ step: 'generate', scenes: [], run: { status: 'running', phase: 'script', jobId: 'j_script', message: 'Writing your script…' } })

  it('one that finished meanwhile opens for review, without being written again', async () => {
    const script = vi.spyOn(api, 'produceScript')
    vi.mocked(api.job).mockImplementation(async (id: string) => job({ id, kind: 'ai.produce.script', result: { script: { scenes: [scene('s01'), scene('s02'), scene('s03')] } } }))
    back(writing())
    const run = resumeRun({ workspaceId: 'ws_a' })
    expect(st().run).toMatchObject({ status: 'running', phase: 'script', message: 'Checking on your script…' })
    await run
    expect(api.job).toHaveBeenCalledWith('j_script')
    expect(script).not.toHaveBeenCalled()
    expect(st()).toMatchObject({ step: 'review', run: { status: 'done', phase: 'script' } })
    expect(st().scenes.map((s) => s.id)).toEqual(['s01', 's02', 's03'])
  })

  it('when it can’t be asked about it stays the same job to resume', async () => {
    FOLLOW.patienceMs = 0
    const script = vi.spyOn(api, 'produceScript')
    vi.mocked(api.job).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    back(writing())
    await resumeRun({ workspaceId: 'ws_a' })
    expect(st().run).toMatchObject({ status: 'idle', phase: 'script', interrupted: true, jobId: 'j_script', message: 'Couldn’t check on your script just now. Resume to pick it up where it is.' })
    expect(script).not.toHaveBeenCalled()
  })

  it('transcribing is left for the person to resume: the script after it was never asked for', () => {
    const script = vi.spyOn(api, 'produceScript')
    back(wizard({ step: 'generate', scenes: [], run: { status: 'running', phase: 'transcribe', jobId: 'j_stt' } }))
    expect(resumeRun({ workspaceId: 'ws_a' })).toBeUndefined()
    expect(st().run).toMatchObject({ status: 'idle', interrupted: true, jobId: 'j_stt', phase: 'transcribe' })
    expect(api.job).not.toHaveBeenCalled()
    expect(script).not.toHaveBeenCalled()
  })
})
