// Professional animation: the model that draws AI-drawn scenes (Settings → AI), the 3D drawing styles, and for videos
// made from an idea the look of AI pictures and clips, full motion (every scene a clip) and what the clips will cost.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AiSettings, ProduceCapabilities, ScriptScene, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { AiProviders } from '../pages/AiProviders'
import ProducerWizard, { aiClipEstimate } from '../producer/ProducerWizard'
import { initialState } from '../producer/wizardLogic'
import { useWizard } from '../producer/wizardStore'
import { systemApi, useSystem } from '../system'

vi.setConfig({ testTimeout: 30_000 })

const eff = { provider: 'none' as const }
const settings = (patch: Partial<AiSettings> = {}): AiSettings => ({
  canEdit: true,
  defaultProvider: 'gemini',
  perFeature: {},
  builtin: { id: 'anthropic-api', available: false, detail: '' },
  providers: { gemini: { model: 'gemini-3-flash', hasKey: true, keyLast4: 'abcd', valid: true, models: ['gemini-3-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-lite'] } },
  media: {},
  videoProvider: null,
  animationModel: null,
  effective: { writer: { provider: 'gemini', model: 'gemini-3-flash' }, script: eff, assistant: eff, animation: { provider: 'gemini', model: 'gemini-3.1-pro-preview' } },
  ...patch,
})

const team: Workspace = { id: 'ws_a', name: 'Team A', role: 'editor', personal: false, memberCount: 3 }
const st = () => useWizard.getState().s
const falCaps: ProduceCapabilities = {
  stock: false,
  kinds: ['motion', 'diagram', 'image', 'aiVideo', 'drawn'],
  maxAiClips: 3,
  maxAiClipsFullMotion: 16,
  image: { provider: 'gemini', model: 'gemini-3.1-flash-image' },
  video: { provider: 'fal', model: 'fal-ai/wan/v2.2-a14b/text-to-video', maxSeconds: 10, fromPicture: true, pricePerSecond: 0.08 },
}

beforeEach(() => {
  sessionStorage.clear()
  useSession.setState({ status: 'ready', workspaces: [team], workspaceId: 'ws_a' })
  useSystem.setState({ load: vi.fn(async () => undefined) } as never)
  useWizard.getState().replace(initialState())
  vi.spyOn(api, 'templates').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue([])
  vi.spyOn(api, 'brand').mockResolvedValue({ name: 'A', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
  vi.spyOn(api, 'saveProducerDraft').mockResolvedValue({ version: 9 })
  vi.spyOn(api, 'project').mockRejectedValue(new Error('not in this test'))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the animation model', () => {
  it('is automatic (the most capable on the key) until the owner picks one, which is saved for the space', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(settings())
    const save = vi.spyOn(systemApi, 'saveAiSettings').mockResolvedValue(settings({ animationModel: 'gemini-3-flash', effective: { ...settings().effective, animation: { provider: 'gemini', model: 'gemini-3-flash' } } }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    const pick = (await screen.findByLabelText('Animation model')) as HTMLSelectElement
    expect(pick.value).toBe('')
    expect(within(pick).getByRole('option', { name: 'Automatic (most capable: gemini-3.1-pro-preview)' })).toBeTruthy()
    fireEvent.change(pick, { target: { value: 'gemini-3-flash' } })
    await waitFor(() => expect(save).toHaveBeenCalledWith({ workspaceId: 'ws_a', animationModel: 'gemini-3-flash' }))
    await waitFor(() => expect((screen.getByLabelText('Animation model') as HTMLSelectElement).value).toBe('gemini-3-flash'))
    // and animation can be pointed at another provider like any feature
    expect(screen.getByLabelText('Animation provider')).toBeTruthy()
  })

  it('isn’t asked on the built-in provider (no model list to pick from)', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(settings({ effective: { ...settings().effective, animation: { provider: 'anthropic-api' } } }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await screen.findByLabelText('Default AI provider')
    expect(screen.queryByLabelText('Animation model')).toBeNull()
  })
})

function showIdea(brief: Partial<ReturnType<typeof initialState>['brief']> = {}) {
  useWizard.getState().replace({ ...initialState(), brief: { ...initialState().brief, source: 'idea', idea: 'A fox finds its way home', lengthSec: 60, ...brief } })
  return render(
    <MemoryRouter initialEntries={['/producer/new']}>
      <Routes>
        <Route path="/producer/new" element={<ProducerWizard />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('full motion and the look of AI pictures and clips', () => {
  it('full motion turns AI clips on and says what it costs; the look goes in the brief', async () => {
    vi.spyOn(api, 'produceCapabilities').mockResolvedValue(falCaps)
    showIdea({ visualKinds: ['motion', 'diagram'] })
    const full = await screen.findByRole('checkbox', { name: /Full motion/ })
    expect(screen.getByText(/each starting from a picture painted first/)).toBeTruthy()
    // 60 s at $0.08 a second
    expect(screen.getByText(/About 8 clips for this length, roughly \$4\.80, billed to your fal\.ai account \(the pictures to your Google account\)/)).toBeTruthy()
    // no look to pick while nothing generated is on
    expect(screen.queryByLabelText('Look of AI pictures and clips')).toBeNull()
    fireEvent.click(full)
    expect(st().brief).toMatchObject({ motion: 'full', visualKinds: ['motion', 'diagram', 'aiVideo'] })
    const look = (await screen.findByLabelText('Look of AI pictures and clips')) as HTMLSelectElement
    expect(look.value).toBe('auto')
    fireEvent.change(look, { target: { value: 'animated3d' } })
    expect(st().brief.aiLook).toBe('animated3d')
    expect(screen.getByText(/like a big-studio animated feature/)).toBeTruthy()
    fireEvent.change(look, { target: { value: 'auto' } })
    expect(st().brief.aiLook).toBeUndefined()
    fireEvent.click(full)
    expect(st().brief.motion).toBeUndefined()
  })

  it('isn’t offered without a key that makes clips', async () => {
    vi.spyOn(api, 'produceCapabilities').mockResolvedValue({ stock: false, kinds: ['motion', 'diagram'], maxAiClips: 3 })
    showIdea()
    await screen.findByLabelText('The idea')
    await waitFor(() => expect(screen.queryByText('Checking…')).toBeNull())
    expect(screen.queryByRole('checkbox', { name: /Full motion/ })).toBeNull()
  })

  it('a 3D drawing style says it renders slower', async () => {
    vi.spyOn(api, 'produceCapabilities').mockResolvedValue(falCaps)
    showIdea({ visualKinds: ['motion', 'drawn'], drawingStyle: 'clay3d' })
    expect(await screen.findByText(/Soft, rounded 3D models like a clay or toy animation, warmly lit\. 3D scenes take a few minutes each to render\./)).toBeTruthy()
  })
})

describe('what the AI clips will cost', () => {
  const sc = (id: string, narration: string, visual?: ScriptScene['visual']): ScriptScene => ({ id, title: id, headline: id, narration, footage: [], ...(visual ? { visual } : {}) })
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')

  it('counts clips still to make, each as long as its scene up to the longest clip, at the price a second', () => {
    const scenes = [
      sc('s1', words(13), { kind: 'aiVideo', prompt: 'a' }),
      sc('s2', words(60), { kind: 'aiVideo', prompt: 'b' }),
      sc('s3', words(13), { kind: 'aiVideo', prompt: 'c', assetId: 'as_made' }),
      sc('s4', words(13), { kind: 'motion', points: [] }),
    ]
    const e = aiClipEstimate(scenes, falCaps)!
    expect(e.clips).toBe(2)
    expect(e.seconds).toBeGreaterThan(10)
    expect(e.seconds).toBeLessThanOrEqual(20)
    expect(e.cost).toBe(Math.round(e.seconds * 0.08 * 100) / 100)
  })

  it('stops at the most clips a video makes, says nothing without clips, and has no price without a price list', () => {
    const many = Array.from({ length: 6 }, (_, i) => sc(`s${i}`, words(13), { kind: 'aiVideo', prompt: String(i) }))
    expect(aiClipEstimate(many, falCaps)!.clips).toBe(3)
    expect(aiClipEstimate(many, falCaps, true)!.clips).toBe(6)
    expect(aiClipEstimate([sc('s1', words(5))], falCaps)).toBeUndefined()
    expect(aiClipEstimate(many, { ...falCaps, video: undefined })).toBeUndefined()
    expect(aiClipEstimate(many, { ...falCaps, video: { ...falCaps.video!, pricePerSecond: undefined } })!.cost).toBeUndefined()
  })
})

describe('Blender scenes', () => {
  it('the Blender style is offered only where scenes can render in Blender, and says where and what it costs', async () => {
    vi.spyOn(api, 'produceCapabilities').mockResolvedValue(falCaps)
    showIdea({ visualKinds: ['motion', 'drawn'] })
    const pick = (await screen.findByLabelText('How AI-drawn scenes are drawn')) as HTMLSelectElement
    await waitFor(() => expect(screen.queryByText('Checking…')).toBeNull())
    expect(within(pick).queryByRole('option', { name: 'Blender (cinematic 3D)' })).toBeNull()
    cleanup()
    vi.spyOn(api, 'produceCapabilities').mockResolvedValue({ ...falCaps, blender: { where: 'runpod', version: 'Blender 5.2' } })
    showIdea({ visualKinds: ['motion', 'drawn'] })
    const again = (await screen.findByLabelText('How AI-drawn scenes are drawn')) as HTMLSelectElement
    await waitFor(() => expect(within(again).getByRole('option', { name: 'Blender (cinematic 3D)' })).toBeTruthy())
    fireEvent.change(again, { target: { value: 'blender' } })
    expect(st().brief.drawingStyle).toBe('blender')
    expect(screen.getByText(/rented from RunPod for this video \(about \$0\.70 an hour, billed to your RunPod account\)/)).toBeTruthy()
  })

  it('on the desktop it renders with this computer’s Blender', async () => {
    vi.spyOn(api, 'produceCapabilities').mockResolvedValue({ ...falCaps, blender: { where: 'computer', version: 'Blender 5.2.4' } })
    showIdea({ visualKinds: ['motion', 'drawn'], drawingStyle: 'blender' })
    expect(await screen.findByText(/Rendered by Blender 5\.2\.4 on this computer/)).toBeTruthy()
  })

  it('a RunPod key is stored like the fal.ai key, on the web edition only', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(settings({ media: { runpod: { hasKey: true, keyLast4: 'WXYZ', valid: true } } }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    const card = await screen.findByLabelText('RunPod (Blender scenes)')
    expect(within(card).getByText(/One card per video/)).toBeTruthy()
    expect((within(card).getByLabelText('API key') as HTMLInputElement).placeholder).toContain('WXYZ')
    cleanup()
    render(<AiProviders desktop renderBuiltin={() => null} />)
    await screen.findByLabelText('Default AI provider')
    expect(screen.queryByLabelText('RunPod (Blender scenes)')).toBeNull()
  })
})
