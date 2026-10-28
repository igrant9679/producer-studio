// Producer AI says on entry when no AI can write the script (QA-9), states the server's real upload limit (QA-10),
// stops at the server's limits instead of sending what it will refuse (APP-39), and Back goes back a step (APP-26).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PRODUCE_LIMITS, type AssetRecord, type ScriptScene, type SystemInfo, type Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { brandApi } from '../../lib/brandApi'
import { useSession } from '../../lib/session'
import { voiceApi } from '../../lib/studioApi'
import ProducerWizard from '../producer/ProducerWizard'
import { canAdvance, initialState, validateScenes, type WizardAsset, type WizardState } from '../producer/wizardLogic'
import { markDraftSaved, useWizard } from '../producer/wizardStore'
import { useSystem } from '../system'

vi.setConfig({ testTimeout: 30_000 })

const team: Workspace = { id: 'ws_a', name: 'Team A', role: 'editor', personal: false, memberCount: 3 }
const mine: Workspace = { id: 'ws_me', name: 'Me', role: 'owner', personal: true, memberCount: 1 }
const scene = (id: string, over: Partial<ScriptScene> = {}): ScriptScene => ({ id, title: id, headline: id, narration: `Narration for ${id}`, footage: [], ...over })
const ready = (n: number): WizardAsset[] => Array.from({ length: n }, (_, i) => ({ localId: `l${i}`, assetId: `as_${i}`, name: `rec${i}.mp4`, size: 10, status: 'ready', progress: 1, duration: 10 }))
const system = (available: boolean): SystemInfo => ({ mode: 'cloud', version: '1', ai: { provider: available ? 'anthropic-api' : 'none', available, detail: available ? 'Ready' : 'No AI key is configured for this workspace.' }, capabilities: { transcribe: true, tts: true, render: true }, limits: { uploadBytes: 2048 * 1024 * 1024 } })

let aiAvailable = false
let systemCalls: string[] = []
function Nav() {
  const navigate = useNavigate()
  const l = useLocation()
  return (
    <>
      <button onClick={() => navigate(-1)}>Browser back</button>
      <span data-testid="url">{l.pathname + l.search}</span>
    </>
  )
}
const show = (path = '/producer/new', before: string[] = ['/home']) =>
  render(
    <MemoryRouter initialEntries={[...before, path]} initialIndex={before.length}>
      <Routes>
        <Route path="/producer/:projectId" element={<><ProducerWizard /><Nav /></>} />
        <Route path="/producer/new" element={<><ProducerWizard /><Nav /></>} />
        <Route path="*" element={<><div>Somewhere else</div><Nav /></>} />
      </Routes>
    </MemoryRouter>,
  )
function load(s: WizardState) {
  markDraftSaved(s)
  useWizard.getState().replace(s)
}

beforeEach(() => {
  sessionStorage.clear()
  aiAvailable = false
  systemCalls = []
  useSession.setState({ status: 'ready', workspaces: [team, mine], workspaceId: 'ws_a' })
  useSystem.setState({ info: system(true), loaded: true })
  vi.spyOn(api, 'templates').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue([])
  vi.spyOn(api, 'brand').mockResolvedValue({ name: 'A', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
  vi.spyOn(api, 'saveProducerDraft').mockResolvedValue({ version: 2 })
  vi.spyOn(api, 'assets').mockResolvedValue([] as AssetRecord[])
  // the brief's brand kits and favourite voices (A-7, A-20): not what these count
  vi.spyOn(brandApi, 'kits').mockResolvedValue({ items: [] })
  vi.spyOn(voiceApi, 'prefs').mockResolvedValue({ favourites: [] })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      systemCalls.push(String(url))
      return new Response(JSON.stringify(system(aiAvailable)), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AI availability on entry (QA-9)', () => {
  it('says on the first step that no AI is set up, who can fix it, and links to Settings → AI', async () => {
    useWizard.getState().replace(initialState())
    show()
    const alert = await screen.findByText(/Producer AI can’t write a script here yet/)
    expect(systemCalls[0]).toBe('/api/system?workspaceId=ws_a')
    const box = alert.closest('[role="alert"]')!
    expect(box.textContent).toMatch(/No AI key is configured/)
    // an editor: only an owner can set it up
    expect(box.textContent).toMatch(/Only an owner of Team A can set up AI/)
    expect(screen.getByRole('link', { name: 'Settings → AI' }).getAttribute('href')).toBe('/settings#ai')
  })

  it('an owner is told to add a key; Write the script waits for it', async () => {
    useSession.setState({ workspaceId: 'ws_me' })
    load({ ...initialState(), workspaceId: 'ws_me', step: 'brief', assets: ready(1), brief: { ...initialState().brief, title: 'Tour' } })
    show()
    expect((await screen.findByText(/Add an AI key in Settings → AI/)).textContent).toBeTruthy()
    expect((screen.getByRole('button', { name: /Write the script/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('with AI available nothing is said and the script can be written', async () => {
    aiAvailable = true
    load({ ...initialState(), workspaceId: 'ws_a', step: 'brief', assets: ready(1), brief: { ...initialState().brief, title: 'Tour' } })
    show()
    await waitFor(() => expect(systemCalls.length).toBe(1))
    await waitFor(() => expect((screen.getByRole('button', { name: /Write the script/ }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText(/can’t write a script here yet/)).toBeNull()
  })
})

describe('upload limit (QA-10)', () => {
  it('states the server’s limit, not “a few GB”', async () => {
    useWizard.getState().replace(initialState())
    show()
    expect(await screen.findByText('MP4, MOV or WebM · up to 2 GB each')).toBeTruthy()
    expect(screen.queryByText(/a few GB/)).toBeNull()
  })
})

describe('the server’s limits, before the long wait (APP-39)', () => {
  it('recordings, scenes, footage windows and narration length', () => {
    const base = { ...initialState(), workspaceId: 'ws_a' }
    expect(canAdvance({ ...base, assets: ready(PRODUCE_LIMITS.recordings) }).ok).toBe(true)
    expect(canAdvance({ ...base, assets: ready(PRODUCE_LIMITS.recordings + 2) })).toEqual({ ok: false, reason: `A video can use at most ${PRODUCE_LIMITS.recordings} recordings: remove 2` })
    const many = Array.from({ length: PRODUCE_LIMITS.scenes + 1 }, (_, i) => scene(`s${i}`))
    expect(validateScenes(many)).toBe(`A video can have at most ${PRODUCE_LIMITS.scenes} scenes: remove 1`)
    expect(validateScenes([scene('a'), scene('b', { narration: 'x'.repeat(PRODUCE_LIMITS.narrationChars + 1) })])).toMatch(/^Scene 2’s narration is over 5,000 characters/)
    const windows = Array.from({ length: PRODUCE_LIMITS.footagePerScene + 1 }, (_, i) => ({ assetId: 'as_0', start: i, end: i + 1 }))
    expect(validateScenes([scene('a', { footage: windows })])).toBe(`Scene 1 has more than ${PRODUCE_LIMITS.footagePerScene} footage windows`)
    expect(validateScenes([scene('a', { footage: windows.slice(0, PRODUCE_LIMITS.footagePerScene) })])).toBeUndefined()
  })

  it('Review caps narration at the server’s length', async () => {
    aiAvailable = true
    load({ ...initialState(), projectId: 'p1', workspaceId: 'ws_a', step: 'review', scenes: [scene('s0')], scriptBrief: initialState().brief, brief: { ...initialState().brief, title: 'Tour', source: 'idea', idea: 'An idea for a video' } })
    show('/producer/p1')
    expect((await screen.findByLabelText('Narration')).getAttribute('maxlength')).toBe(String(PRODUCE_LIMITS.narrationChars))
    expect((screen.getByRole('button', { name: 'Add scene' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('Back goes back a step (APP-26)', () => {
  it('each step is a history entry: Back returns to the brief, then the start, then leaves', async () => {
    aiAvailable = true
    const scenes = [scene('s1')]
    load({ ...initialState(), projectId: 'p1', workspaceId: 'ws_a', step: 'upload', assets: ready(1), transcribed: ['as_0'], scenes, scriptBrief: { ...initialState().brief, title: 'Tour' }, brief: { ...initialState().brief, title: 'Tour' } })
    show('/producer/p1')
    fireEvent.click(await screen.findByRole('button', { name: /Continue to brief/ }))
    expect(screen.getByTestId('url').textContent).toBe('/producer/p1?step=brief')
    fireEvent.click(screen.getByRole('button', { name: /Back to script/ }))
    expect(useWizard.getState().s.step).toBe('review')
    expect(screen.getByTestId('url').textContent).toBe('/producer/p1?step=review')
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Browser back' })))
    await waitFor(() => expect(useWizard.getState().s.step).toBe('brief'))
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Browser back' })))
    await waitFor(() => expect(useWizard.getState().s.step).toBe('upload'))
    expect(screen.getByTestId('url').textContent).toBe('/producer/p1')
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Browser back' })))
    expect(await screen.findByText('Somewhere else')).toBeTruthy()
  })

  it('a step that can’t be shown now (a run in progress) keeps the wizard where it is', async () => {
    aiAvailable = true
    load({ ...initialState(), projectId: 'p1', workspaceId: 'ws_a', step: 'assemble', assets: ready(1), transcribed: ['as_0'], scenes: [scene('s1')], run: { status: 'running', phase: 'assemble' }, brief: { ...initialState().brief, title: 'Tour' } })
    show('/producer/p1?step=assemble', ['/home', '/producer/p1?step=review'])
    await screen.findByText('Assembling your video')
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Browser back' })))
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/producer/p1?step=assemble'))
    expect(useWizard.getState().s.step).toBe('assemble')
  })
})
