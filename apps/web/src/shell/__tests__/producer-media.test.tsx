// Videos from an idea, your own clips and images, or both — no recording needed: Home starts Producer on an idea
// when nothing (or an image) is attached, the files added to an idea go to the writer as media (never transcribed),
// and a scene can show one of them.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Job, ProjectDocResponse, ScriptScene, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import ProducerWizard from '../producer/ProducerWizard'
import { handoffSource, setProducerHandoff } from '../producer/handoff'
import { initialState, stateFromProject, type WizardState } from '../producer/wizardLogic'
import { markDraftSaved, runGenerate, useWizard } from '../producer/wizardStore'

vi.setConfig({ testTimeout: 30_000 })

const team: Workspace = { id: 'ws_a', name: 'Team A', role: 'editor', personal: false, memberCount: 3 }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const job = (over: Partial<Job> = {}): Job<any> => ({ id: 'j1', kind: 'ai.produce.script', status: 'done', progress: 1, message: 'Done', workspaceId: 'ws_a', projectId: 'p1', result: {}, createdAt: 0, updatedAt: 0, ...over })
const file = (name: string, type: string) => new File(['x'], name, { type })
const ready = (assetId: string, duration?: number) => ({ localId: assetId, assetId, name: assetId, size: 1, status: 'ready' as const, progress: 1, duration })
const st = () => useWizard.getState().s

function show(path = '/producer/new') {
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
  useWizard.getState().replace(initialState())
  useSession.setState({ status: 'ready', workspaces: [team], workspaceId: 'ws_a' })
  vi.spyOn(api, 'templates').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue([])
  vi.spyOn(api, 'brand').mockResolvedValue({ name: 'A', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
  vi.spyOn(api, 'saveProducerDraft').mockResolvedValue({ version: 9 })
  vi.spyOn(api, 'produceCapabilities').mockResolvedValue({ stock: false, kinds: ['motion', 'diagram'], maxAiClips: 3 })
  vi.spyOn(api, 'job').mockImplementation(async () => job())
  vi.spyOn(api, 'project').mockRejectedValue(new Error('not in this test'))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('where a video from Home comes from', () => {
  it('an idea when nothing or any image is attached; recordings only when only videos are; a quick start says which', () => {
    expect(handoffSource({ files: [] })).toBe('idea')
    expect(handoffSource({ files: [file('team.jpg', 'image/jpeg'), file('beach.mp4', 'video/mp4')] })).toBe('idea')
    expect(handoffSource({ files: [file('screen.mp4', 'video/mp4')] })).toBe('recordings')
    expect(handoffSource({ files: [], source: 'recordings' })).toBe('recordings')
  })

  it('a prompt with nothing attached opens Producer on the idea, with what was typed', async () => {
    setProducerHandoff({ prompt: 'A 60-second animated explainer of how our product works', aspect: '9:16', files: [] })
    show()
    const idea = (await screen.findByLabelText('The idea')) as HTMLTextAreaElement
    expect(idea.value).toBe('A 60-second animated explainer of how our product works')
    expect(st().brief).toMatchObject({ source: 'idea', aspect: '9:16' })
    expect(screen.queryByRole('heading', { name: 'Add your recordings' })).toBeNull()
    expect(screen.getAllByText(/^Your clips and images/).length).toBeGreaterThan(0)
  })

  it('a quick start on an idea keeps a draft in progress, and only changes where it comes from', async () => {
    const draft = initialState({ prompt: 'Our spring launch' })
    useWizard.getState().replace({ ...draft, assets: [ready('as_photo')] })
    setProducerHandoff({ prompt: '', aspect: '16:9', files: [], source: 'idea' })
    show()
    await screen.findByLabelText('The idea')
    expect(st().brief.source).toBe('idea')
    expect(st().brief.title).toBe(draft.brief.title)
    expect(st().assets.map((a) => a.assetId)).toEqual(['as_photo'])
  })
})

describe('your own clips and images in a video made from an idea', () => {
  it('go to the writer as media, and nothing is transcribed', async () => {
    const base = initialState()
    useWizard.getState().replace({ ...base, workspaceId: 'ws_a', projectId: 'p1', brief: { ...base.brief, title: 'Trip', source: 'idea', idea: 'Our team trip to the coast' }, assets: [ready('as_beach', 12), ready('as_team')] })
    const transcribe = vi.spyOn(api, 'transcribe')
    const script = vi.spyOn(api, 'produceScript').mockResolvedValue(job({ id: 'j_script' }))
    vi.mocked(api.job).mockImplementation(async (id: string) => job({ id, result: { script: { scenes: [{ id: 's01', title: 'T', headline: 'H', narration: 'N', footage: [], visual: { kind: 'media', assetId: 'as_team' } }] } } }))
    await runGenerate('ws_a')
    expect(transcribe).not.toHaveBeenCalled()
    expect(script.mock.calls[0][0]).toMatchObject({ assetIds: ['as_beach', 'as_team'], brief: { source: 'idea' } })
    expect(st().scenes[0].visual).toEqual({ kind: 'media', assetId: 'as_team' })
  })

  it('wait until they have processed before the script can be written', async () => {
    const base = initialState()
    useWizard.getState().replace({ ...base, workspaceId: 'ws_a', brief: { ...base.brief, source: 'idea', idea: 'Our team trip to the coast' }, assets: [{ ...ready('as_beach'), status: 'processing' as const }] })
    const { canAdvance } = await import('../producer/wizardLogic')
    expect(canAdvance(st(), 'upload')).toEqual({ ok: false, reason: 'Waiting for your clips and images to finish processing' })
  })

  it('a scene can show one of them, and a clip can start later', async () => {
    const scenes: ScriptScene[] = [{ id: 's01', title: 'Beach', headline: 'The beach', narration: 'And this is where we went.', footage: [], visual: { kind: 'media', assetId: 'as_beach' } }]
    const base = initialState()
    const s: WizardState = { ...base, projectId: 'p1', workspaceId: 'ws_a', step: 'review', scenes, scriptBrief: { ...base.brief, source: 'idea', title: 'Trip' }, brief: { ...base.brief, source: 'idea', title: 'Trip', template: 'studio-dark' }, assets: [ready('as_beach', 12), ready('as_team')], draft: { state: 'saved' } }
    markDraftSaved(s)
    useWizard.getState().replace(s)
    show('/producer/p1')
    const which = (await screen.findByLabelText('Which clip or image')) as HTMLSelectElement
    expect([...which.options].map((o) => o.value)).toEqual(['as_beach', 'as_team'])
    expect((screen.getByLabelText('On screen') as HTMLSelectElement).value).toBe('media')
    fireEvent.change(screen.getByLabelText('Start the clip at (seconds)'), { target: { value: '4' } })
    await waitFor(() => expect(st().scenes[0].visual).toEqual({ kind: 'media', assetId: 'as_beach', start: 4 }))
    fireEvent.change(which, { target: { value: 'as_team' } })
    await waitFor(() => expect(st().scenes[0].visual).toEqual({ kind: 'media', assetId: 'as_team' }))
    // an image has no start time
    expect(screen.queryByLabelText('Start the clip at (seconds)')).toBeNull()
  })

  it('reopening the project lists the clips and images its scenes show', () => {
    const res = {
      summary: { id: 'p1', workspaceId: 'ws_a', name: 'Trip' },
      project: {
        assets: { as_team: { id: 'as_team', kind: 'image', name: 'team.jpg', src: '' } },
        ai: { brief: { ...initialState().brief, source: 'idea' }, status: 'scripted', script: { scenes: [{ id: 's01', title: 'T', headline: 'H', narration: 'N', footage: [], visual: { kind: 'media', assetId: 'as_team' } }] } },
      },
    } as unknown as ProjectDocResponse
    expect(stateFromProject(res).assets.map((a) => [a.assetId, a.name])).toEqual([['as_team', 'team.jpg']])
  })
})

describe('how AI-drawn scenes are drawn', () => {
  it('can be picked when drawn scenes are on, and goes in the brief', async () => {
    vi.spyOn(api, 'produceCapabilities').mockResolvedValue({ stock: false, kinds: ['motion', 'diagram', 'drawn'], maxAiClips: 3 })
    useWizard.getState().replace({ ...initialState(), brief: { ...initialState().brief, source: 'idea', idea: 'How bridges stand up', visualKinds: ['motion', 'drawn'] } })
    show()
    const pick = (await screen.findByLabelText('How AI-drawn scenes are drawn')) as HTMLSelectElement
    // the clean look until another is chosen
    expect(pick.value).toBe('clean')
    expect(pick.options.length).toBe(13)
    fireEvent.change(pick, { target: { value: 'blueprint' } })
    expect(st().brief.drawingStyle).toBe('blueprint')
    expect(screen.getByText(/White lines on blue paper/)).toBeTruthy()
  })

  it('is not offered while drawn scenes are off', async () => {
    vi.spyOn(api, 'produceCapabilities').mockResolvedValue({ stock: false, kinds: ['motion', 'diagram', 'drawn'], maxAiClips: 3 })
    useWizard.getState().replace({ ...initialState(), brief: { ...initialState().brief, source: 'idea', idea: 'How bridges stand up', visualKinds: ['motion'] } })
    show()
    await screen.findByText('The idea')
    await waitFor(() => expect(screen.queryByText('Checking…')).toBeNull())
    expect(screen.queryByLabelText('How AI-drawn scenes are drawn')).toBeNull()
  })
})
