// First-run onboarding on Home (A-6): the checklist shows the space's real progress, ticks itself when something
// changes, links the sample project, hides per person and space, and isn't shown to viewers.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AssetRecord, OnboardingState, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../../lib/api'
import { useSession } from '../../lib/session'
import { onboardingApi } from '../../lib/studioApi'
import { OnboardingChecklist } from '../components/Onboarding'
import { liveBus } from '../stores'

vi.setConfig({ testTimeout: 30_000 })

const team: Workspace = { id: 'ws_team', name: 'Studio', role: 'owner', personal: false, memberCount: 1 }
const fresh: OnboardingState = { steps: { upload: false, brand: true, producer: false, invite: false }, dismissed: false, sampleProjectId: 'p_sample' }

const show = () =>
  render(
    <MemoryRouter>
      <OnboardingChecklist />
    </MemoryRouter>,
  )

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaces: [team], workspaceId: team.id })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<OnboardingChecklist>', () => {
  it('lists the four steps with what is done, links the sample project and each next step', async () => {
    vi.spyOn(onboardingApi, 'get').mockResolvedValue(fresh)
    show()
    const box = await screen.findByRole('region', { name: 'Get started' })
    expect(box.textContent).toMatch(/1 of 4 done in Studio/)
    const items = within(box).getAllByRole('listitem')
    expect(items.map((li) => li.querySelector('strong')?.textContent)).toEqual(['Upload a recording (to do)', 'Set your brand kit (done)', 'Make a first Producer video (to do)', 'Invite a teammate (to do)'])
    expect(within(items[1]).queryByRole('link')).toBeNull()
    expect(within(items[3]).getByRole('link', { name: 'Invite' }).getAttribute('href')).toBe('/space')
    expect(within(box).getByRole('link', { name: /Open the sample project/ }).getAttribute('href')).toBe('/edit/p_sample')
    expect(within(box).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
  })

  it('ticks itself when the space changes (an upload arrives on the live stream)', async () => {
    const get = vi.spyOn(onboardingApi, 'get').mockResolvedValueOnce(fresh).mockResolvedValue({ ...fresh, steps: { ...fresh.steps, upload: true } })
    show()
    await screen.findByText(/1 of 4 done/)
    act(() => liveBus.emitAsset({ workspaceId: 'ws_team', asset: { id: 'as_1' } } as AssetRecord))
    await screen.findByText(/2 of 4 done/)
    expect(get).toHaveBeenCalledTimes(2)
    // another space's upload is not this checklist's business
    act(() => liveBus.emitAsset({ workspaceId: 'ws_other', asset: { id: 'as_2' } } as AssetRecord))
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('Hide keeps it hidden for this person (and puts it back if the save fails)', async () => {
    vi.spyOn(onboardingApi, 'get').mockResolvedValue(fresh)
    const set = vi.spyOn(onboardingApi, 'setDismissed').mockRejectedValueOnce(new HttpError(500, { error: 'Down' })).mockResolvedValue({ ...fresh, dismissed: true })
    show()
    await screen.findByRole('region', { name: 'Get started' })
    fireEvent.click(screen.getByRole('button', { name: 'Hide the checklist' }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('ws_team', true))
    await screen.findByRole('region', { name: 'Get started' })
    fireEvent.click(screen.getByRole('button', { name: 'Hide the checklist' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull())
    expect(set).toHaveBeenCalledTimes(2)
  })

  it('isn’t shown to a viewer, who can’t do the steps; an editor is asked to have an owner invite', async () => {
    vi.spyOn(onboardingApi, 'get').mockResolvedValue(fresh)
    useSession.setState({ workspaces: [{ ...team, role: 'viewer' }] })
    show()
    await waitFor(() => expect(onboardingApi.get).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull()
    cleanup()
    useSession.setState({ workspaces: [{ ...team, role: 'editor' }] })
    show()
    const box = await screen.findByRole('region', { name: 'Get started' })
    expect(within(box).getByText('Ask an owner of this space')).toBeTruthy()
  })

  it('says all set once every step is done', async () => {
    vi.spyOn(onboardingApi, 'get').mockResolvedValue({ steps: { upload: true, brand: true, producer: true, invite: true }, dismissed: false })
    show()
    expect((await screen.findByRole('region', { name: 'You’re all set' })).textContent).toMatch(/Every step is done/)
  })
})
