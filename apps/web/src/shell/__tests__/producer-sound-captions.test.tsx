// The brief, 19 Nov 2026 (the owner): its music and sound effects can be heard before they are picked, and its captions
// can be turned off or given a look, font, size and place, with a sample of how they will look.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Voice, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { brandApi } from '../../lib/brandApi'
import { useSession } from '../../lib/session'
import ProducerWizard from '../producer/ProducerWizard'
import { initialState, type WizardState } from '../producer/wizardLogic'
import { markDraftSaved, useWizard } from '../producer/wizardStore'

vi.setConfig({ testTimeout: 120_000 })

const team: Workspace = { id: 'ws_a', name: 'Team A', role: 'editor', personal: false, memberCount: 3 }
const voices: Voice[] = [{ id: 'af_heart', name: 'Heart', lang: 'American English', gender: 'female', style: 'Warm' }] as Voice[]
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

function brief(over: Partial<WizardState['brief']> = {}): WizardState {
  const base = initialState()
  return { ...base, projectId: 'p1', workspaceId: 'ws_a', step: 'brief', brief: { ...base.brief, title: 'Spring tour', template: 'studio-dark', ...over } }
}
const st = () => useWizard.getState().s
const show = (s: WizardState) => {
  markDraftSaved(s)
  useWizard.getState().replace(s)
  return render(
    <MemoryRouter initialEntries={['/producer/p1']}>
      <Routes>
        <Route path="/producer/:projectId" element={<ProducerWizard />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  sessionStorage.clear()
  played.length = 0
  vi.stubGlobal('Audio', FakeAudio)
  useSession.setState({ status: 'ready', workspaces: [team], workspaceId: 'ws_a' })
  vi.spyOn(api, 'templates').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue(voices)
  vi.spyOn(api, 'brand').mockResolvedValue({ name: 'A', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
  vi.spyOn(api, 'saveProducerDraft').mockResolvedValue({ version: 9 })
  vi.spyOn(api, 'project').mockRejectedValue(new Error('not in this test'))
  vi.spyOn(brandApi, 'kits').mockResolvedValue({ items: [] })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('hearing the brief’s sound', () => {
  it('plays a sample of the chosen music style, and stops it', async () => {
    show(brief({ music: 'lofi' }))
    const listen = await screen.findByRole('button', { name: /Listen to Lo-fi/ })
    fireEvent.click(listen)
    expect(played).toEqual(['/api/music/style/lofi/preview'])
    expect(screen.getByRole('button', { name: /Stop/ }).getAttribute('aria-pressed')).toBe('true')
    // another style plays its own sample
    fireEvent.change(screen.getByLabelText('Music'), { target: { value: 'cinematic' } })
    fireEvent.click(screen.getByRole('button', { name: /Listen to Cinematic/ }))
    expect(played.at(-1)).toBe('/api/music/style/cinematic/preview')
    // no music: nothing to hear
    fireEvent.change(screen.getByLabelText('Music'), { target: { value: 'off' } })
    expect(screen.queryByRole('button', { name: /Listen to Cinematic/ })).toBeNull()
  })

  it('plays the sound effects of the kit that goes with the music, one after another', async () => {
    show(brief({ music: 'pulse' }))
    fireEvent.click(await screen.findByRole('button', { name: /Listen to the effects/ }))
    await waitFor(() => expect(played).toHaveLength(3), { timeout: 4000 })
    expect(played).toEqual(['/api/music/sfx/launch/whoosh.short', '/api/music/sfx/launch/pop', '/api/music/sfx/launch/click.confirm'])
  })
})

describe('the captions in the brief', () => {
  it('can be given a look, a font, a size and a place, shown in a sample', async () => {
    const { container } = show(brief())
    const looks = await screen.findByRole('radiogroup', { name: 'Caption look' })
    expect(within(looks).getByRole('radio', { name: 'Clean' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(looks).getByRole('radio', { name: 'Karaoke' }))
    expect(st().brief.captionPreset).toBe('karaoke')
    fireEvent.change(screen.getByLabelText('Font'), { target: { value: 'Montserrat' } })
    expect(st().brief.captionFont).toBe('Montserrat')
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Caption size' })).getByRole('radio', { name: 'Large' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Caption place' })).getByRole('radio', { name: 'Top' }))
    expect(st().brief).toMatchObject({ captionSize: 'large', captionPosition: 'top' })
    const sample = container.querySelector('.ps-capsample span') as HTMLElement
    expect(sample.style.top).toBe('14%')
    expect(sample.style.fontFamily).toMatch(/Montserrat/)
    expect(sample.style.textTransform).toBe('uppercase')
    // back to the brand's font
    fireEvent.change(screen.getByLabelText('Font'), { target: { value: '' } })
    expect(st().brief.captionFont).toBeUndefined()
  })

  it('are left out when Captions is off, and the choices go with them', async () => {
    show(brief())
    await screen.findByRole('radiogroup', { name: 'Caption look' })
    fireEvent.click(screen.getByRole('checkbox', { name: /Captions/ }))
    expect(st().brief.captions).toBe(false)
    expect(screen.queryByRole('radiogroup', { name: 'Caption look' })).toBeNull()
  })
})
