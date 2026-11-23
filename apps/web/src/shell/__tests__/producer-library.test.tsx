// Producer uses the media library (23 Nov 2026): the brief's music can be a library song (the tone's, or one picked and
// heard first), a scene can show a library clip, the video can carry the brand's logo stamp, and the export of a video
// Producer made starts with a branded cover.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { LibraryClip, LibraryEntry, LibraryTrack, ScriptScene, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { brandApi } from '../../lib/brandApi'
import { useSession } from '../../lib/session'
import ProducerWizard from '../producer/ProducerWizard'
import { defaultVisual, VISUAL_KIND_INFO } from '../producer/sceneVisuals'
import { forgetLibraryLists } from '../producer/useLibrary'
import { defaultBrief, initialState, type WizardState } from '../producer/wizardLogic'
import { markDraftSaved, useWizard } from '../producer/wizardStore'

vi.setConfig({ testTimeout: 120_000 })

const team: Workspace = { id: 'ws_a', name: 'Team A', role: 'editor', personal: false, memberCount: 3 }
const songs: Array<LibraryEntry<LibraryTrack>> = [
  { id: 'bright-ideas', title: 'Bright Ideas', genre: 'Corporate pop', mood: 'Optimistic background', prompt: '', ready: true, seconds: 120 },
  { id: 'still-water', title: 'Still Water', genre: 'Solo piano', mood: 'Calm and reflective', prompt: '', ready: true, seconds: 110 },
  { id: 'neon-pulse', title: 'Neon Pulse', genre: 'House', mood: 'Energetic', prompt: '', ready: false },
]
const clips: Array<LibraryEntry<LibraryClip>> = [
  { id: 'rocket-launch', title: 'Rocket Launch', kind: 'animation', style: 'clean', seconds: 8, prompt: 'A cartoon rocket lifts off. No words, letters, numbers or logos anywhere in the picture.', ready: true },
  { id: 'coffee-pour', title: 'Coffee Pour', kind: 'motion', seconds: 8, prompt: 'Hot coffee poured into a white cup.', ready: true },
  { id: 'city-dusk', title: 'City at Dusk', kind: 'motion', seconds: 8, prompt: 'A skyline at dusk.', ready: false },
]
const played: string[] = []
class FakeAudio {
  volume = 1
  onended: (() => void) | null = null
  constructor(public src: string) {}
  play() {
    played.push(this.src)
    return Promise.resolve()
  }
  pause() {}
}
const st = () => useWizard.getState().s
const show = (s: WizardState, path = '/producer/p1') => {
  markDraftSaved(s)
  useWizard.getState().replace(s)
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/producer/new" element={<ProducerWizard />} />
        <Route path="/producer/:projectId" element={<ProducerWizard />} />
      </Routes>
    </MemoryRouter>,
  )
}
function brief(over: Partial<WizardState['brief']> = {}): WizardState {
  const base = initialState()
  return { ...base, projectId: 'p1', workspaceId: 'ws_a', step: 'brief', brief: { ...base.brief, title: 'Morning ritual', template: 'studio-dark', tone: 'Friendly', ...over } }
}
const kit = (over: Record<string, unknown> = {}) => ({ items: [{ id: 'default', default: true, doc: { name: 'Northwind', colors: [], fonts: { headline: 'Inter', body: 'Inter' }, ...over }, updatedAt: 0, etag: 'e' }] })

beforeEach(() => {
  sessionStorage.clear()
  played.length = 0
  forgetLibraryLists()
  vi.stubGlobal('Audio', FakeAudio)
  useSession.setState({ status: 'ready', workspaces: [team], workspaceId: 'ws_a' })
  vi.spyOn(api, 'templates').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue([])
  vi.spyOn(api, 'brand').mockResolvedValue({ name: 'Northwind', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
  vi.spyOn(api, 'saveProducerDraft').mockResolvedValue({ version: 9 })
  vi.spyOn(api, 'project').mockRejectedValue(new Error('not in this test'))
  vi.spyOn(api, 'musicLibrary').mockResolvedValue(songs)
  vi.spyOn(api, 'clipLibrary').mockResolvedValue(clips)
  vi.spyOn(api, 'produceCapabilities').mockResolvedValue({ stock: false, kinds: ['motion', 'diagram', 'library'], maxAiClips: 3 })
  vi.spyOn(brandApi, 'kits').mockResolvedValue(kit() as never)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a new brief', () => {
  it('starts with a library song that suits the tone and the brand’s stamp', () => {
    expect(defaultBrief()).toMatchObject({ music: 'library', logoStamp: true })
  })
})

describe('library songs in the brief', () => {
  it('lists the songs made, says which one suits the tone, and plays the one picked', async () => {
    show(brief({ music: 'library' }))
    const music = (await screen.findByLabelText('Music')) as HTMLSelectElement
    await waitFor(() => expect(within(music).getByRole('option', { name: 'Suits the tone (Bright Ideas)' })).toBeTruthy())
    const group = music.querySelector('optgroup[label="Songs from the media library"]')!
    expect([...group.querySelectorAll('option')].map((o) => o.value)).toEqual(['library', 'library:bright-ideas', 'library:still-water'])
    expect(music.value).toBe('library')
    expect(screen.getByText(/Corporate pop, optimistic background\. A finished song from the media library, cut to your video’s length/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Listen to Bright Ideas/ }))
    expect(played).toEqual(['/api/music/bright-ideas/preview'])
    // another tone, another song
    fireEvent.click(screen.getByRole('button', { name: 'Calm' }))
    await waitFor(() => expect(within(music).getByRole('option', { name: 'Suits the tone (Still Water)' })).toBeTruthy())
    // a song picked
    fireEvent.change(music, { target: { value: 'library:bright-ideas' } })
    expect(st().brief.music).toBe('library:bright-ideas')
    fireEvent.click(screen.getByRole('button', { name: /Listen to Bright Ideas/ }))
    expect(played.at(-1)).toBe('/api/music/bright-ideas/preview')
    // the composed styles are still there
    fireEvent.change(music, { target: { value: 'lofi' } })
    expect(screen.getByRole('button', { name: /Listen to Lo-fi/ })).toBeTruthy()
  })

  it('shows composed music where the library has no songs yet', async () => {
    vi.mocked(api.musicLibrary).mockResolvedValue([])
    show(brief({ music: 'library', tone: 'Calm' }))
    const music = (await screen.findByLabelText('Music')) as HTMLSelectElement
    await waitFor(() => expect(music.value).toBe('auto'))
    expect(music.querySelector('optgroup[label="Songs from the media library"]')).toBeNull()
    expect(screen.getByRole('button', { name: /Listen to Ambient/ })).toBeTruthy()
  })
})

describe('the brand’s stamp in the brief', () => {
  it('stamps the brand’s name while the kit has no logo, and can be turned off', async () => {
    show(brief({ logoStamp: true }))
    const box = (await screen.findByRole('checkbox', { name: /Stamp “Northwind” small in the bottom-right corner/ })) as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(screen.getByText(/Your brand kit has no logo yet, so its name is stamped/)).toBeTruthy()
    fireEvent.click(box)
    expect(st().brief.logoStamp).toBe(false)
  })

  it('knows the brand of the space open now for a new video, which has no project (and no space) of its own yet', async () => {
    show({ ...brief({ logoStamp: true }), projectId: undefined, workspaceId: undefined }, '/producer/new?step=brief')
    expect(await screen.findByRole('checkbox', { name: /Stamp “Northwind” small/ })).toBeTruthy()
    expect(brandApi.kits).toHaveBeenCalledWith('ws_a')
  })

  it('stamps the logo when the kit has one, and says it opens and closes the video', async () => {
    vi.mocked(brandApi.kits).mockResolvedValue(kit({ logoAssetId: 'as_logo' }) as never)
    show(brief({ logoStamp: false }))
    const box = (await screen.findByRole('checkbox', { name: /Stamp your logo small/ })) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(screen.getByText('Your logo also opens and closes the video, above the title and on the closing card.')).toBeTruthy()
  })
})

describe('a library clip in a scene', () => {
  it('is a visual Producer may use, starting on the first clip made', () => {
    expect(VISUAL_KIND_INFO.library.label).toBe('Library clip')
    expect(defaultVisual('library', { headline: 'H', narration: 'N' }, [], ['coffee-pour'])).toEqual({ kind: 'library', id: 'coffee-pour' })
    expect(defaultVisual('library', { headline: 'H', narration: 'N' }, [], [])).toEqual({ kind: 'motion', points: [] })
  })

  it('shows which clip, what it shows, and can be changed to another', async () => {
    const scenes: ScriptScene[] = [{ id: 's01', title: 'Pour', headline: 'The pour', narration: 'Pour slowly.', footage: [], visual: { kind: 'library', id: 'coffee-pour', assetId: 'as_copy' } }]
    const base = initialState()
    show({ ...base, projectId: 'p1', workspaceId: 'ws_a', step: 'review', scenes, scriptBrief: { ...base.brief, source: 'idea', title: 'Coffee' }, brief: { ...base.brief, source: 'idea', title: 'Coffee', template: 'studio-dark' }, draft: { state: 'saved' } })
    const which = (await screen.findByLabelText('Which library clip')) as HTMLSelectElement
    await waitFor(() => expect([...which.options].map((o) => o.value)).toEqual(['rocket-launch', 'coffee-pour']))
    expect(which.value).toBe('coffee-pour')
    expect((screen.getByLabelText('On screen') as HTMLSelectElement).value).toBe('library')
    expect(screen.getByText(/Hot coffee poured into a white cup\. 8 s; a longer scene holds its last frame\./)).toBeTruthy()
    expect(document.querySelector('img[src="/api/clips/coffee-pour/poster"]')).toBeTruthy()
    // not "made at the last assembly": it was chosen
    expect(screen.queryByText(/Made at the last assembly/)).toBeNull()
    fireEvent.change(which, { target: { value: 'rocket-launch' } })
    await waitFor(() => expect(st().scenes[0].visual).toEqual({ kind: 'library', id: 'rocket-launch' }))
    // what an animation shows, without the instructions it was drawn with
    expect(screen.getByText(/A cartoon rocket lifts off\. 8 s;/)).toBeTruthy()
  })
})
