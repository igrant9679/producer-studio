// Linking the desktop to a cloud account (D-5): sign in, see what would be merged and uploaded with sizes, choose per
// space, then link; Cancel removes the preview's device link; an older desktop without the preview links directly.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LinkPreview, SyncStatus } from '@producer/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../../lib/api'
import { useSession } from '../../lib/session'
import { LinkForm } from '../sync/LinkFlow'
import { systemApi } from '../system'

const preview: LinkPreview = {
  previewId: 'lp_1',
  account: 'sam@example.com',
  cloudUrl: 'https://cloud.test',
  expiresAt: Date.now() + 600_000,
  cloudSpaces: [
    { id: 'w_personal', name: 'Sam’s space', personal: true, role: 'owner' },
    { id: 'w_team', name: 'Team', personal: false, role: 'editor' },
    { id: 'w_view', name: 'Client review', personal: false, role: 'viewer' },
  ],
  spaces: [
    { id: 'l_personal', name: 'My space', personal: true, projects: 3, clips: 4, uploadBytes: 2.5 * 1024 ** 3, voices: 1, suggested: { action: 'merge', into: 'w_personal' } },
    { id: 'l_side', name: 'Side project', personal: false, projects: 1, clips: 2, uploadBytes: 50 * 1024 ** 2, voices: 0, suggested: { action: 'new' } },
  ],
  setAside: { account: 'old@example.com', spaces: ['Old work'] },
}
const linked: SyncStatus = { linked: true, state: 'syncing', pending: 0, conflicts: [], account: 'sam@example.com' }

function signIn() {
  render(<LinkForm />)
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-1' } })
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the first-link preview', () => {
  it('shows what each space holds and where it goes, with sizes, then links as chosen', async () => {
    vi.spyOn(systemApi, 'linkPreview').mockResolvedValue(preview)
    const link = vi.spyOn(systemApi, 'linkAsPreviewed').mockResolvedValue(linked)
    vi.spyOn(useSession.getState(), 'load').mockResolvedValue(undefined as never)
    signIn()
    const heading = await screen.findByRole('heading', { name: 'Before linking sam@example.com' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.getByText(/3 projects, 4 clips, 1 voice/)).toBeTruthy()
    expect(screen.getByText(/2\.5 GB to upload/)).toBeTruthy()
    expect(screen.getByRole('note').textContent).toContain('Old work')
    const side = screen.getByLabelText('Where “Side project” goes') as HTMLSelectElement
    // a space only viewed in the cloud can't take anything
    expect([...side.options].map((o) => o.textContent)).toEqual(['Merge into “Sam’s space” (your personal space)', 'Merge into “Team”', 'Create “Side project” in the cloud', 'Keep it on this computer only'])
    expect(side.value).toBe('new')
    fireEvent.change(side, { target: { value: 'local' } })
    // what stays here doesn't upload
    expect(screen.getByText(/2\.5 GB of clips will upload in the background/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Where “My space” goes'), { target: { value: 'merge:w_team' } })
    fireEvent.click(screen.getByRole('button', { name: /Link and sync/ }))
    await waitFor(() => expect(link).toHaveBeenCalledWith('lp_1', { l_personal: { action: 'merge', into: 'w_team' }, l_side: { action: 'local' } }))
  })

  it('Cancel drops the preview and its device link, back on the sign-in form', async () => {
    vi.spyOn(systemApi, 'linkPreview').mockResolvedValue(preview)
    const cancel = vi.spyOn(systemApi, 'cancelLinkPreview').mockResolvedValue({ ok: true })
    signIn()
    fireEvent.click(await screen.findByRole('button', { name: /Cancel/ }))
    expect(cancel).toHaveBeenCalledWith('lp_1')
    expect(screen.getByRole('form', { name: 'Link a cloud account' })).toBeTruthy()
  })

  it('a wrong password says so; an older desktop without the preview links straight away', async () => {
    vi.spyOn(systemApi, 'linkPreview').mockRejectedValueOnce(new HttpError(401, { error: 'nope' }))
    signIn()
    expect((await screen.findByRole('alert')).textContent).toBe('The cloud rejected that email or password.')
    cleanup()
    vi.spyOn(systemApi, 'linkPreview').mockRejectedValueOnce(new HttpError(404, { error: 'Not found', code: 'not_found' }))
    const direct = vi.spyOn(systemApi, 'link').mockResolvedValue(linked)
    vi.spyOn(useSession.getState(), 'load').mockResolvedValue(undefined as never)
    signIn()
    await waitFor(() => expect(direct).toHaveBeenCalledWith('https://producerstudio.app', 'sam@example.com', 'correct-horse-1'))
  })
})
