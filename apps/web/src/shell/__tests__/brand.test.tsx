// Brand kit: a kit that fails to load is never replaced by defaults with Save enabled (APP-2); unsaved edits stay with
// their space, bad hex colours are said, and closing the tab asks first (APP-27).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BrandKitDoc, Workspace } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, HttpError } from '../../lib/api'
import { useSession } from '../../lib/session'
import BrandPage from '../pages/BrandPage'

vi.setConfig({ testTimeout: 30_000 })

const team: Workspace = { id: 'ws_team', name: 'Northwind', role: 'editor', personal: false, memberCount: 3 }
const kit: BrandKitDoc = { name: 'Northwind', colors: ['#123456', '#abcdef'], fonts: { headline: 'Montserrat', body: 'Inter' }, logoAssetId: 'as_logo', captionPreset: 'clean', voice: 'am_eric' }

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaces: [team], workspaceId: team.id })
  vi.spyOn(api, 'voices').mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<BrandPage>', () => {
  it('a kit that fails to load shows the error with Retry, and nothing that could save over it', async () => {
    const brand = vi.spyOn(api, 'brand').mockRejectedValueOnce(new HttpError(500, { error: 'Database unavailable' })).mockResolvedValueOnce(kit)
    const save = vi.spyOn(api, 'saveBrand').mockResolvedValue(kit)
    render(<BrandPage />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Couldn’t load this space’s brand kit: Database unavailable/)
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull()
    expect(screen.queryByLabelText('Brand name')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect((screen.getByLabelText('Brand name') as HTMLInputElement).value).toBe('Northwind'))
    expect(brand).toHaveBeenCalledTimes(2)
    // loaded: nothing to save until something changes
    expect((screen.getByRole('button', { name: /Saved/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('a colour that isn’t hex is said at the field and holds Save, instead of being dropped (APP-27)', async () => {
    vi.spyOn(api, 'brand').mockResolvedValue(kit)
    const save = vi.spyOn(api, 'saveBrand').mockImplementation(async (_w, d) => d)
    render(<BrandPage />)
    const hex = await screen.findByLabelText('Hex for colour 2')
    fireEvent.change(hex, { target: { value: 'tomato' } })
    expect(screen.getByRole('alert').textContent).toMatch(/Colour 2 \(“tomato”\) isn’t a hex colour/)
    expect(hex.getAttribute('aria-invalid')).toBe('true')
    const btn = screen.getByRole('button', { name: /Save changes/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.change(hex, { target: { value: '#ff6347' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(btn)
    await waitFor(() => expect(save).toHaveBeenCalledWith('ws_team', expect.objectContaining({ colors: ['#123456', '#ff6347'] })))
  })

  it('a space switch keeps unsaved edits with their space, and they are back on return (APP-27)', async () => {
    const other: Workspace = { id: 'ws_other', name: 'Contoso', role: 'owner', personal: false, memberCount: 2 }
    useSession.setState({ workspaces: [team, other], user: { id: 'u_1', email: 'a@b.c', name: 'A' } as never })
    vi.spyOn(api, 'brand').mockImplementation(async (id: string) => (id === 'ws_other' ? { ...kit, name: 'Contoso' } : kit))
    const save = vi.spyOn(api, 'saveBrand').mockImplementation(async (_w, d) => d)
    render(<BrandPage />)
    await waitFor(() => expect((screen.getByLabelText('Brand name') as HTMLInputElement).value).toBe('Northwind'))
    fireEvent.change(screen.getByLabelText('Brand name'), { target: { value: 'Northwind Labs' } })
    act(() => useSession.setState({ workspaceId: 'ws_other' }))
    await waitFor(() => expect((screen.getByLabelText('Brand name') as HTMLInputElement).value).toBe('Contoso'))
    // Contoso's kit is its own: nothing to save there
    expect((screen.getByRole('button', { name: /Saved/ }) as HTMLButtonElement).disabled).toBe(true)
    act(() => useSession.setState({ workspaceId: 'ws_team' }))
    await waitFor(() => expect((screen.getByLabelText('Brand name') as HTMLInputElement).value).toBe('Northwind Labs'))
    expect(screen.getByText(/Your unsaved changes from earlier are back/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('ws_team', expect.objectContaining({ name: 'Northwind Labs' })))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('asks the browser to confirm closing the tab while edits are unsaved (APP-27)', async () => {
    vi.spyOn(api, 'brand').mockResolvedValue(kit)
    render(<BrandPage />)
    await waitFor(() => expect((screen.getByLabelText('Brand name') as HTMLInputElement).value).toBe('Northwind'))
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    fireEvent.change(screen.getByLabelText('Brand name'), { target: { value: 'Changed' } })
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Discard/ }))
  })

  it('shows the kit the server returns (its defaults when the space has none) as saved', async () => {
    vi.spyOn(api, 'brand').mockResolvedValue(kit)
    render(<BrandPage />)
    await waitFor(() => expect((screen.getByLabelText('Brand name') as HTMLInputElement).value).toBe('Northwind'))
    fireEvent.change(screen.getByLabelText('Brand name'), { target: { value: 'Northwind Labs' } })
    expect((screen.getByRole('button', { name: /Save changes/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})
