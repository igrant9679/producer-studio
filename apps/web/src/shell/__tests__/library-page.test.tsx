// Library: Enter only opens a preview from the card itself (APP-10), failed media says why and offers Retry (APP-22),
// and Copy share link before any export offers to export instead (APP-23).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AssetRecord, ProjectSummary, ShareLink, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, HttpError } from '../../lib/api'
import { useSession } from '../../lib/session'
import LibraryPage from '../pages/LibraryPage'

vi.setConfig({ testTimeout: 30_000 })

const ws: Workspace = { id: 'ws_me', name: 'Me', role: 'owner', personal: true, memberCount: 1 }
const project: ProjectSummary = { id: 'p_1', workspaceId: ws.id, name: 'Launch', width: 1920, height: 1080, duration: 12, isTemplate: false, trashed: false, kind: 'edit', updatedAt: 2, createdAt: 1, createdBy: 'u' }
const clip = (over: Partial<AssetRecord> = {}): AssetRecord =>
  ({ asset: { id: 'as_1', kind: 'video', name: 'Interview.mov', src: '', duration: 30, sizeBytes: 1000 }, status: 'ready', workspaceId: ws.id, origin: 'upload', createdAt: 1, ...over }) as AssetRecord

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search}</div>
}
const show = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/library" element={<LibraryPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaces: [ws], workspaceId: ws.id })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Library media cards', () => {
  it('Enter on the rename field or a menu item does not open the preview; Enter on the card does (APP-10)', async () => {
    vi.spyOn(api, 'assets').mockResolvedValue([clip()])
    show('/library?tab=assets')
    const card = await screen.findByRole('button', { name: 'Preview Interview.mov' })
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Interview.mov' }))
    const del = screen.getByRole('menuitem', { name: /Delete/ })
    fireEvent.keyDown(del, { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }))
    const field = screen.getByRole('textbox', { name: 'Name' })
    vi.spyOn(api, 'renameAsset').mockResolvedValue(clip({ asset: { ...clip().asset, name: 'Interview take 2.mov' } }))
    fireEvent.change(field, { target: { value: 'Interview take 2.mov' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('a clip that failed says why and offers Retry (APP-22)', async () => {
    vi.spyOn(api, 'assets').mockResolvedValue([clip({ status: 'error', error: 'This file is incomplete or damaged — the moov atom is missing' })])
    const retry = vi.spyOn(api, 'retryAsset').mockResolvedValue(clip({ status: 'processing' }))
    show('/library?tab=assets')
    expect(await screen.findByText(/the moov atom is missing/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry processing Interview.mov' }))
    await waitFor(() => expect(retry).toHaveBeenCalledWith('as_1'))
    expect(await screen.findByText(/Processing…/)).toBeTruthy()
    // the click didn't also try to preview it
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Library share links (APP-23)', () => {
  it('a project with no export offers to export instead of copying a link to an empty page', async () => {
    vi.spyOn(api, 'projects').mockResolvedValue([project])
    const share = vi.spyOn(api, 'share').mockRejectedValue(new HttpError(409, { error: 'Export the video first: a share link shows a finished export.', code: 'conflict' }))
    show('/library')
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Launch' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy share link/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/Export this project first/)
    expect(share).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /Open and export/ }))
    expect(screen.getByTestId('where').textContent).toBe('/edit/p_1?export=1')
  })

  it('with an export it copies the link the server keeps for it', async () => {
    vi.spyOn(api, 'projects').mockResolvedValue([project])
    const link: ShareLink = { token: 'tok', url: '/r/tok', exportId: 'ex_1', createdAt: 1 }
    vi.spyOn(api, 'share').mockResolvedValue(link)
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    show('/library')
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Launch' }))
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /Copy share link/ })))
    await waitFor(() => expect(write).toHaveBeenCalledWith(`${location.origin}/r/tok`))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
