// Voice Studio (A-20): a draft per space, pause and emphasis markup, the pronunciation dictionary, batch voiceovers
// from a CSV, favourite voices, side-by-side comparison, and whether the desktop holding a cloned voice is online.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AssetRecord, Job, Voice, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { voiceApi } from '../../lib/studioApi'
import VoiceStudio from '../pages/VoiceStudio'
import { voiceHost } from '../components/VoiceCard'
import { applyMarkup, compareLine } from '../voicestudio/ScriptTools'
import { useTtsDraft } from '../voicestudio/ttsDraft'

vi.mock('../voicestudio/MyVoices', () => ({ MyVoices: () => <div>My voices panel</div> }))
vi.setConfig({ testTimeout: 120_000 })

const A: Workspace = { id: 'ws_a', name: 'Agency', role: 'editor', personal: false, memberCount: 2 }
const B: Workspace = { id: 'ws_b', name: 'Client', role: 'owner', personal: false, memberCount: 1 }
const cloned: Voice = { id: 'vs:p1', name: 'Idris clone', lang: 'English', gender: 'custom', style: 'Cloned voice', source: 'clone', available: false, detail: 'Open Producer Studio on Studio PC to use this voice' }

beforeEach(() => {
  useTtsDraft.setState({ ws: undefined, text: '', name: '', speed: 1, voice: undefined, byWs: {}, favourites: {}, loaded: {}, gen: undefined })
  useSession.setState({ status: 'ready', workspaces: [A, B], workspaceId: A.id, user: { id: 'u_1', email: 'a@b.c', name: 'A' } as never })
  vi.spyOn(api, 'assets').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue([cloned, { id: 'af_heart', name: 'Heart', lang: 'American English', gender: 'female', style: 'Warm narrator' }, { id: 'am_eric', name: 'Eric', lang: 'American English', gender: 'male', style: 'Confident' }])
  vi.spyOn(api, 'brand').mockResolvedValue({ name: 'Me', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
  vi.spyOn(voiceApi, 'prefs').mockImplementation(async (ws) => (ws === 'ws_a' ? { favourites: ['am_eric'] } : { favourites: [], draft: { text: 'Saved on another device', name: '', speed: 1 } }))
  vi.spyOn(voiceApi, 'savePrefs').mockImplementation(async (_ws, p) => ({ favourites: p.favourites ?? [] }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const show = () => render(<MemoryRouter initialEntries={['/voice']}><VoiceStudio /></MemoryRouter>)
const script = () => screen.getByLabelText('Voiceover script') as HTMLTextAreaElement

describe('<VoiceStudio> A-20', () => {
  it('keeps a draft per space: a switch puts it away and brings the other space’s back (or its saved one)', async () => {
    show()
    fireEvent.change(script(), { target: { value: 'Agency intro script' } })
    act(() => useSession.setState({ workspaceId: 'ws_b' }))
    await waitFor(() => expect(script().value).toBe('Saved on another device'))
    fireEvent.change(script(), { target: { value: 'Client teaser' } })
    act(() => useSession.setState({ workspaceId: 'ws_a' }))
    await waitFor(() => expect(script().value).toBe('Agency intro script'))
    act(() => useSession.setState({ workspaceId: 'ws_b' }))
    await waitFor(() => expect(script().value).toBe('Client teaser'))
    // and it is saved for the space shortly after typing stops
    await waitFor(() => expect(voiceApi.savePrefs).toHaveBeenCalledWith('ws_b', { draft: { text: 'Client teaser', name: '', speed: 1 } }), { timeout: 4000 })
  })

  it('inserts a pause and stresses the selected words; the estimate counts the pause', async () => {
    show()
    fireEvent.change(script(), { target: { value: 'This is big news' } })
    script().setSelectionRange(8, 11)
    fireEvent.click(screen.getByRole('button', { name: /Emphasis/ }))
    expect(script().value).toBe('This is *big* news')
    script().setSelectionRange(script().value.length, script().value.length)
    fireEvent.click(screen.getByRole('button', { name: /^Pause$/ }))
    expect(script().value).toBe('This is *big* news [pause] ')
    expect(screen.getByText(/4 words · ≈ 0:0[12]/)).toBeTruthy()
    expect(applyMarkup('a b', 2, 2, 'emphasis').text).toBe('a b')
    expect(compareLine('First one. Second one.', '')).toBe('First one.')
    expect(compareLine('First one. Second one.', 'Second')).toBe('Second')
  })

  it('stars favourite voices for the space and filters by them', async () => {
    show()
    const star = await screen.findByRole('button', { name: 'Remove Eric from favourites' })
    expect(star.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Add Heart to favourites' }))
    await waitFor(() => expect(voiceApi.savePrefs).toHaveBeenCalledWith('ws_a', { favourites: ['am_eric', 'af_heart'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Favourites' }))
    const list = screen.getByRole('radiogroup', { name: 'Voices' })
    expect(within(list).getAllByRole('radio').map((r) => r.querySelector('strong')?.textContent)).toEqual(['Heart', 'Eric'])
  })

  it('says whether the desktop holding a cloned voice is online', async () => {
    show()
    expect(await screen.findByText('Desktop offline')).toBeTruthy()
    expect(voiceHost({ ...cloned, available: true, detail: 'Generated on Studio PC' })).toEqual({ online: true, label: 'Desktop online' })
    expect(voiceHost({ id: 'af_heart', name: 'Heart', lang: 'x', gender: 'female', style: 'x' })).toBeNull()
  })

  it('edits the space’s pronunciations', async () => {
    vi.spyOn(voiceApi, 'settings').mockResolvedValue({ pronunciations: [{ word: 'SQL', say: 'sequel' }] })
    const save = vi.spyOn(voiceApi, 'saveSettings').mockImplementation(async (_w, s) => s)
    show()
    fireEvent.click(screen.getByRole('button', { name: /Pronunciations/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Pronunciations' })
    expect((await within(dialog).findByLabelText('Word 1') as HTMLInputElement).value).toBe('SQL')
    fireEvent.click(within(dialog).getByRole('button', { name: /Add a word/ }))
    fireEvent.change(within(dialog).getByLabelText('Word 2'), { target: { value: 'Acme' } })
    fireEvent.change(within(dialog).getByLabelText('Say word 2 as'), { target: { value: 'Ack-me' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('ws_a', { pronunciations: [{ word: 'SQL', say: 'sequel' }, { word: 'Acme', say: 'Ack-me' }] }))
  })

  it('makes a voiceover per CSV row, skipping the rows with a problem', async () => {
    let n = 0
    const tts = vi.spyOn(api, 'tts').mockImplementation(async () => ({ id: `j_${++n}`, kind: 'ai.tts', status: 'queued', progress: 0, workspaceId: 'ws_a', createdAt: 0, updatedAt: 0 }) as Job<{ asset: AssetRecord; duration: number }>)
    vi.spyOn(api, 'job').mockImplementation((async (id: string) => ({ id, kind: 'ai.tts', status: 'done', progress: 1, workspaceId: 'ws_a', createdAt: 0, updatedAt: 0, result: { asset: { asset: { id: `as_${id}` } }, duration: 1 } })) as typeof api.job)
    show()
    fireEvent.click(screen.getByRole('button', { name: /Batch from CSV/ }))
    const dialog = await screen.findByRole('dialog', { name: /Batch voiceovers/ })
    const input = document.querySelector('input[accept=".csv,text/csv"]') as HTMLInputElement
    const file = new File(['name,text,voice\nIntro,Welcome aboard,am_eric\nBad,Nope,zz_robot\nOutro,See you soon,'], 'lines.csv', { type: 'text/csv' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    await within(dialog).findByText(/lines.csv: 3 rows, 1 with a problem/)
    expect(within(dialog).getByText('Unknown voice “zz_robot”')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /Generate 2 voiceovers/ }))
    await waitFor(() => expect(within(dialog).getAllByText('Done')).toHaveLength(2))
    expect(tts.mock.calls.map((c) => [c[0].text, c[0].voice, c[0].name])).toEqual([
      ['Welcome aboard', 'am_eric', 'Intro'],
      ['See you soon', 'af_heart', 'Outro'],
    ])
  })

  it('compares the same line in several voices and picks one', async () => {
    const preview = vi.spyOn(voiceApi, 'preview').mockResolvedValue(new Blob(['RIFF'], { type: 'audio/wav' }))
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    show()
    // the space's favourites are in
    await screen.findByRole('button', { name: 'Remove Eric from favourites' })
    fireEvent.change(script(), { target: { value: 'Meet the new dashboard. It is fast.' } })
    fireEvent.click(screen.getByRole('button', { name: /Compare voices/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Compare voices' })
    expect((within(dialog).getByLabelText('Line') as HTMLTextAreaElement).value).toBe('Meet the new dashboard.')
    // cloned voices can't be previewed here: only built-in ones are offered
    expect(within(dialog).queryByRole('option', { name: /Idris clone/ })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: /Hear them/ }))
    // the voice picked and the space's favourite first
    const takes = within(dialog).getAllByLabelText(/^Voice \d$/).length
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(takes))
    expect(preview.mock.calls.map((c) => c[1].voice).slice(0, 2)).toEqual(['af_heart', 'am_eric'])
    expect(preview.mock.calls[0][1].text).toBe('Meet the new dashboard.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use Eric' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(useTtsDraft.getState().voice).toBe('am_eric')
  })
})
