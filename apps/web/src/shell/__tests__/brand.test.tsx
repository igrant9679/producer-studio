// Brand kit: a kit that fails to load is never replaced by defaults with Save enabled (APP-2).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('shows the kit the server returns (its defaults when the space has none) as saved', async () => {
    vi.spyOn(api, 'brand').mockResolvedValue(kit)
    render(<BrandPage />)
    await waitFor(() => expect((screen.getByLabelText('Brand name') as HTMLInputElement).value).toBe('Northwind'))
    fireEvent.change(screen.getByLabelText('Brand name'), { target: { value: 'Northwind Labs' } })
    expect((screen.getByRole('button', { name: /Save changes/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})
