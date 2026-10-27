// Voice Studio keeps the script and a running generation across its own tab switches, and a voiceover that finishes
// after you left plays only if Voice Studio is still on screen (APP-20).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AssetRecord, Job, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useAudioPreview } from '../ui'
import VoiceStudio from '../pages/VoiceStudio'

vi.mock('../voicestudio/MyVoices', () => ({ MyVoices: () => <div>My voices panel</div> }))
vi.setConfig({ testTimeout: 30_000 })

const ws: Workspace = { id: 'ws_me', name: 'Me', role: 'owner', personal: true, memberCount: 1 }
const voiceover = { asset: { id: 'as_vo', kind: 'audio', name: 'Welcome', src: '', duration: 3 }, status: 'ready', workspaceId: 'ws_me', origin: 'tts', createdAt: 1, updatedAt: 1 } as unknown as AssetRecord
const ttsJob = (over: Partial<Job>): Job => ({ id: 'j_tts', kind: 'ai.tts', status: 'running', progress: 0.4, message: 'Generating voice', workspaceId: 'ws_me', createdAt: 0, updatedAt: 0, ...over })

let release: () => void
let finishedJob = false
let toggle: ReturnType<typeof vi.fn>
let n = 0
beforeEach(() => {
  useSession.setState({ status: 'ready', workspaces: [ws], workspaceId: ws.id })
  vi.spyOn(api, 'assets').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue([])
  vi.spyOn(api, 'brand').mockResolvedValue({ name: 'Me', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
  const id = `j_tts_${++n}`
  vi.spyOn(api, 'tts').mockResolvedValue(ttsJob({ id, status: 'queued', progress: 0, message: 'Queued' }) as Job<{ asset: AssetRecord; duration: number }>)
  // this test's job: running on the first poll, done once released (anything else is already done)
  const finished = new Promise<void>((r) => (release = r))
  const done = () => ttsJob({ status: 'done', progress: 1, result: { asset: voiceover, duration: 3 } })
  let polls = 0
  finishedJob = false
  vi.spyOn(api, 'job').mockImplementation((async (jobId: string) => {
    if (jobId !== id) return done()
    if (polls++ === 0) return ttsJob({ id })
    await finished
    finishedJob = true
    return done()
  }) as typeof api.job)
  toggle = vi.fn()
  useAudioPreview.setState({ toggle })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const show = () => render(<MemoryRouter initialEntries={['/voice']}><VoiceStudio /></MemoryRouter>)
const script = () => screen.getByLabelText('Voiceover script') as HTMLTextAreaElement

async function startGenerating() {
  show()
  fireEvent.change(script(), { target: { value: 'Welcome back to the show.' } })
  fireEvent.click(screen.getByRole('button', { name: /^Generate/ }))
  await screen.findByText('Generating voice')
}

describe('<VoiceStudio> text to speech', () => {
  it('keeps the script and the generation in progress across its own tabs', async () => {
    await startGenerating()
    fireEvent.click(screen.getByRole('tab', { name: /My voices/ }))
    expect(screen.getByText('My voices panel')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /Text to speech/ }))
    expect(script().value).toBe('Welcome back to the show.')
    expect(screen.getByText('Generating voice')).toBeTruthy()
    act(() => release())
    await waitFor(() => expect(toggle).toHaveBeenCalledWith('asset:as_vo', '/api/media/as_vo/source'))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate/ })).toBeTruthy())
  })

  it('a voiceover finishing after you left Voice Studio does not play wherever you are', async () => {
    await startGenerating()
    cleanup()
    act(() => release())
    await waitFor(() => expect(finishedJob).toBe(true), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(toggle).not.toHaveBeenCalled()
    // and the script is still there when you come back
    show()
    expect(script().value).toBe('Welcome back to the show.')
  })
})
