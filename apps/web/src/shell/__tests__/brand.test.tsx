// Brand kit: a kit that fails to load is never replaced by defaults with Save enabled (APP-2); unsaved edits stay with
// their space, bad hex colours are said, and closing the tab asks first (APP-27).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { BrandKitDoc, BrandKitSummary, Workspace } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, HttpError } from '../../lib/api'
import { brandApi } from '../../lib/brandApi'
import { useSession } from '../../lib/session'
import BrandPage from '../pages/BrandPage'

vi.setConfig({ testTimeout: 30_000 })

const team: Workspace = { id: 'ws_team', name: 'Northwind', role: 'editor', personal: false, memberCount: 3 }
const kit: BrandKitDoc = { name: 'Northwind', colors: ['#123456', '#abcdef'], fonts: { headline: 'Montserrat', body: 'Inter' }, logoAssetId: 'as_logo', captionPreset: 'clean', voice: 'am_eric' }

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaces: [team], workspaceId: team.id })
  vi.spyOn(api, 'voices').mockResolvedValue([])
  // a server with one kit, unless a test lists more
  vi.spyOn(brandApi, 'kits').mockRejectedValue(new HttpError(404, { error: 'Not found' }))
  vi.spyOn(brandApi, 'fonts').mockResolvedValue([])
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

  it('keeps several kits: switching with unsaved edits asks to save or discard first, and an extra kit saves with its base (A-21)', async () => {
    const extra: BrandKitSummary = { id: 'bk_retail', default: false, doc: { ...kit, name: 'Northwind Retail' }, updatedAt: 1, etag: '"e1"' }
    vi.spyOn(api, 'brand').mockResolvedValue(kit)
    vi.spyOn(brandApi, 'kits').mockResolvedValue({ items: [{ id: 'default', default: true, doc: kit, updatedAt: 1 }, extra] })
    vi.spyOn(brandApi, 'fonts').mockResolvedValue([])
    const saveKit = vi.spyOn(brandApi, 'saveKit').mockImplementation(async (_w, id, d) => ({ ...extra, id, doc: d, etag: '"e2"' }))
    render(<BrandPage />)
    const picker = (await screen.findByLabelText('Kit')) as HTMLSelectElement
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Northwind (default)', 'Northwind Retail'])
    fireEvent.change(screen.getByLabelText('Brand name'), { target: { value: 'Northwind Labs' } })
    fireEvent.change(picker, { target: { value: 'bk_retail' } })
    const ask = await screen.findByRole('dialog', { name: /Save your changes first/ })
    expect(ask.textContent).toMatch(/unsaved changes to “Northwind”/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect((screen.getByLabelText('Brand name') as HTMLInputElement).value).toBe('Northwind Labs')
    fireEvent.change(screen.getByLabelText('Kit'), { target: { value: 'bk_retail' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect((screen.getByLabelText('Brand name') as HTMLInputElement).value).toBe('Northwind Retail'))
    expect(screen.getByRole('button', { name: /Make default/ })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Brand name'), { target: { value: 'Retail 2027' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(saveKit).toHaveBeenCalledWith('ws_team', 'bk_retail', expect.objectContaining({ name: 'Retail 2027' }), '"e1"'))
    // the default's edits were discarded, never saved
    expect(screen.queryByText(/unsaved changes from earlier/)).toBeNull()
  })

  it('checks contrast between the kit’s colours, and pulls colours from the logo (A-21)', async () => {
    vi.spyOn(api, 'brand').mockResolvedValue({ ...kit, colors: ['#ffffff', '#000000', '#777777'] })
    const palette = vi.spyOn(brandApi, 'palette').mockResolvedValue({ colors: ['#ff5a5f', '#0b1830'] })
    render(<BrandPage />)
    const list = await screen.findByRole('list', { name: /Contrast of text colours/ })
    const rows = within(list).getAllByRole('listitem').map((r) => r.getAttribute('aria-label'))
    expect(rows[0]).toMatch(/^#ffffff on #000000: 21 to 1, AAA/)
    expect(rows.some((r) => /#777777 on #ffffff: 4\.48 to 1, AA large \(headlines and captions only\)/.test(r ?? ''))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Colours from the logo/ }))
    const found = await screen.findByRole('group', { name: 'Colours found in the logo' })
    expect(palette).toHaveBeenCalledWith('ws_team', 'as_logo')
    expect(within(found).getAllByRole('img').map((i) => i.getAttribute('aria-label'))).toEqual(['#ff5a5f', '#0b1830'])
    fireEvent.click(within(found).getByRole('button', { name: 'Use these colours' }))
    expect((screen.getByLabelText('Hex for colour 1') as HTMLInputElement).value).toBe('#ff5a5f')
    expect(screen.queryByLabelText('Hex for colour 3')).toBeNull()
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeTruthy()
  })

  it('offers fonts uploaded to the space for headline and body, and a viewer can’t upload or make kits (A-21)', async () => {
    useSession.setState({ workspaces: [{ ...team, role: 'viewer' }] })
    vi.spyOn(api, 'brand').mockResolvedValue(kit)
    vi.spyOn(brandApi, 'kits').mockResolvedValue({ items: [{ id: 'default', default: true, doc: kit, updatedAt: 1 }] })
    vi.spyOn(brandApi, 'fonts').mockResolvedValue([{ id: 'bf_1', family: 'Acme Sans', format: 'woff2', weight: 700, italic: false, sizeBytes: 10, url: '/api/x' }])
    render(<BrandPage />)
    await screen.findByRole('list', { name: 'Uploaded fonts' })
    const headline = screen.getByLabelText('Headline font') as HTMLSelectElement
    expect(within(headline).getByRole('group', { name: 'Uploaded to this space' }).textContent).toBe('Acme Sans')
    expect((screen.getByRole('button', { name: /Upload a font/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /New kit/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Remove the font file Acme Sans 700' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the kit the server returns (its defaults when the space has none) as saved', async () => {
    vi.spyOn(api, 'brand').mockResolvedValue(kit)
    render(<BrandPage />)
    await waitFor(() => expect((screen.getByLabelText('Brand name') as HTMLInputElement).value).toBe('Northwind'))
    fireEvent.change(screen.getByLabelText('Brand name'), { target: { value: 'Northwind Labs' } })
    expect((screen.getByRole('button', { name: /Save changes/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})
