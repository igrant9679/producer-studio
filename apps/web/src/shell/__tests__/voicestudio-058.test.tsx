// VoiceStudio 0.5.8 in Producer Studio: emotion ("how it's said") on profile voices and Stories lines, the model-licence
// dialog a refused request opens, and sound effects on the website through a linked desktop.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AssetRecord, Job, Voice, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { parseStory } from '../../lib/storyStems'
import VoiceStudio from '../pages/VoiceStudio'
import { useTtsDraft } from '../voicestudio/ttsDraft'
import { LicenceAsk } from '../voicestudio/ModelLicences'
import { CloudSoundEffects } from '../voicestudio/NewAudioTools'
import { useLicenceAsk, vsApi, vsFetch } from '../voicestudio/vsApi'

vi.mock('../voicestudio/MyVoices', () => ({ MyVoices: () => <div>My voices panel</div> }))
vi.setConfig({ testTimeout: 60_000 })

const ws: Workspace = { id: 'ws_me', name: 'Me', role: 'owner', personal: true, memberCount: 1 }
const FP = `v2:${'a'.repeat(64)}`
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaces: [ws], workspaceId: ws.id })
  useLicenceAsk.getState().clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Stories: how a line is said', () => {
  it('reads [emotion: …] after the name, or on a narrator line, and keeps it off the words', () => {
    const l = parseStory('[Maya] [emotion: excited] We did it!\nTOM: [emotion:quietly worried] Are you sure?\n[emotion: a whisper] The house was silent.\n[Maya] Plain line.')
    expect(l.map((x) => [x.character, x.text, x.emotion])).toEqual([
      ['Maya', 'We did it!', 'excited'],
      ['Tom', 'Are you sure?', 'quietly worried'],
      ['', 'The house was silent.', 'a whisper'],
      ['Maya', 'Plain line.', undefined],
    ])
  })
})

describe('model licences', () => {
  it('a request refused for an unaccepted licence says where to accept it and opens the dialog with that model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { detail: { code: 'model_licence_required', message: 'Licence not accepted for k2-fsa/OmniVoice.', models: [{ repo_id: 'k2-fsa/OmniVoice', license: 'CC-BY-NC', fingerprint: FP }] } })))
    await expect(vsFetch('/generate', { body: new FormData() })).rejects.toThrow('Accept the licence of k2-fsa/OmniVoice first (Voice Studio → Engine), then try again.')
    expect(useLicenceAsk.getState().models).toEqual([{ repo_id: 'k2-fsa/OmniVoice', license: 'CC-BY-NC', fingerprint: FP }])
  })

  it('the dialog shows the terms and accepts them only once the box is ticked, with the fingerprint it was shown', async () => {
    const details = vi.spyOn(vsApi, 'licenceDetails').mockResolvedValue({
      repo_id: 'k2-fsa/OmniVoice',
      info: { license: 'CC-BY-NC', commercial_inference: 'restricted', credit: 'OmniVoice — Han Zhu and coauthors', source_url: 'https://huggingface.co/k2-fsa/OmniVoice' },
      acceptance: { required: true, accepted: false, state: 'not_accepted', fingerprint: FP },
    })
    const accept = vi.spyOn(vsApi, 'acceptLicence').mockResolvedValue({ required: true, accepted: true, state: 'accepted', fingerprint: FP })
    render(<LicenceAsk />)
    act(() => useLicenceAsk.getState().ask([{ repo_id: 'k2-fsa/OmniVoice', fingerprint: FP }]))
    expect(await screen.findByText('CC-BY-NC')).toBeTruthy()
    expect(details).toHaveBeenCalledWith('k2-fsa/OmniVoice')
    expect(screen.getByText(/Not for commercial use\./)).toBeTruthy()
    const btn = screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(btn)
    await waitFor(() => expect(accept).toHaveBeenCalledWith('k2-fsa/OmniVoice', FP))
    await waitFor(() => expect(useLicenceAsk.getState().models).toBeUndefined())
  })
})

describe('sound effects on the website', () => {
  it('without a desktop that can make them, says what it needs; with one, makes the sound there and plays it', async () => {
    let available = false
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/voice/sfx/available') return json(200, available ? { available: true, device: 'Studio PC' } : { available: false })
      if (url === '/api/voice/sfx' && init?.method === 'POST') return json(200, { id: 'j_sfx', kind: 'voice.relay', status: 'queued', progress: 0, workspaceId: 'ws_me', createdAt: 0, updatedAt: 0 })
      return json(404, { error: 'not here' })
    })
    vi.stubGlobal('fetch', fetch)
    const made = { asset: { id: 'as_sfx', kind: 'audio', name: 'Sound effect · rain', src: '', duration: 6 }, status: 'ready', workspaceId: 'ws_me', origin: 'voicestudio', createdAt: 1, updatedAt: 1 } as unknown as AssetRecord
    vi.spyOn(api, 'job').mockResolvedValue({ id: 'j_sfx', kind: 'voice.relay', status: 'done', progress: 1, workspaceId: 'ws_me', createdAt: 0, updatedAt: 0, result: { asset: made } } as Job)
    render(<CloudSoundEffects />)
    expect(await screen.findByText(/linked computer with an NVIDIA graphics card/)).toBeTruthy()
    available = true
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/Made on Studio PC/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Describe the sound'), { target: { value: 'rain on a tin roof' } })
    fireEvent.click(screen.getByRole('button', { name: /Make the sound/ }))
    await waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toBe('/api/media/as_sfx/source'))
    const post = fetch.mock.calls.find(([u, i]) => u === '/api/voice/sfx' && i?.method === 'POST')!
    expect(JSON.parse(post[1]!.body as string)).toEqual({ workspaceId: 'ws_me', prompt: 'rain on a tin roof', duration: 10 })
  })
})

describe('text to speech: how it is said', () => {
  const kokoro: Voice = { id: 'af_heart', name: 'Heart', lang: 'en-US', gender: 'female', style: 'warm' }
  const dana: Voice = { id: 'vs:p1', name: 'Dana', lang: 'English', gender: '', style: '', source: 'clone', engine: 'cosyvoice', available: true }

  it('is offered for a VoiceStudio voice and goes with the request; a built-in voice neither shows nor sends it', async () => {
    useTtsDraft.setState({ text: '', name: '', speed: 1, emotion: '', voice: undefined, gen: undefined })
    vi.spyOn(api, 'assets').mockResolvedValue([])
    vi.spyOn(api, 'voices').mockResolvedValue([kokoro, dana])
    vi.spyOn(api, 'brand').mockResolvedValue({ name: 'Me', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
    const tts = vi.spyOn(api, 'tts').mockResolvedValue({ id: 'j_tts', kind: 'ai.tts', status: 'queued', progress: 0, workspaceId: 'ws_me', createdAt: 0, updatedAt: 0 } as Job<{ asset: AssetRecord; duration: number }>)
    vi.spyOn(api, 'job').mockResolvedValue({ id: 'j_tts', kind: 'ai.tts', status: 'done', progress: 1, workspaceId: 'ws_me', createdAt: 0, updatedAt: 0, result: {} } as Job)
    render(<MemoryRouter initialEntries={['/voice']}><VoiceStudio /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('radio', { name: /Heart/ }))
    expect(screen.queryByLabelText('How it’s said')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /Dana/ }))
    fireEvent.change(screen.getByLabelText('How it’s said'), { target: { value: 'warm and excited' } })
    fireEvent.change(screen.getByLabelText('Voiceover script'), { target: { value: 'We did it!' } })
    fireEvent.click(screen.getByRole('button', { name: /^Generate/ }))
    await waitFor(() => expect(tts).toHaveBeenCalled())
    expect(tts.mock.calls[0][0]).toMatchObject({ voice: 'vs:p1', text: 'We did it!', emotion: 'warm and excited' })
  })
})
