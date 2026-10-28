// Media in the Library (A-14, A-15, P-23): a delete says which projects use the clip and puts it in the trash (with
// Undo); the trash restores or, with a clear notice, removes for good; the preview steps through the clips with the
// arrow keys, shows the transcript and starts a project from the clip; a file is replaced in place.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AssetRecord, User, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useToasts } from '../../lib/toast'
import LibraryPage from '../pages/LibraryPage'
import { useSystem } from '../system'

vi.setConfig({ testTimeout: 30_000 })

const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const ws: Workspace = { id: 'ws_me', name: 'Me', role: 'owner', personal: true, memberCount: 1 }
const clip = (id: string, over: Partial<AssetRecord> = {}, asset: Partial<AssetRecord['asset']> = {}): AssetRecord =>
  ({ asset: { id, kind: 'video', name: `${id}.mov`, src: '', duration: 30, sizeBytes: 1000, width: 1280, height: 720, ...asset }, status: 'ready', workspaceId: ws.id, origin: 'upload', createdAt: 10, ...over }) as AssetRecord

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
  useSession.setState({ status: 'ready', user: me, workspaces: [ws], workspaceId: ws.id })
  useToasts.setState({ toasts: [] })
  vi.spyOn(api, 'projects').mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a safer delete (A-14, P-23)', () => {
  it('says which projects use the clip, moves it to the trash, and Undo brings it back', async () => {
    vi.spyOn(api, 'assets').mockResolvedValue([clip('as_1'), clip('as_2')])
    vi.spyOn(api, 'assetUsage').mockResolvedValue({ assetId: 'as_1', projects: [{ id: 'p_1', name: 'Launch', trashed: false }, { id: 'p_2', name: 'Teaser', trashed: false }, { id: 'p_3', name: 'Old', trashed: true }] })
    const del = vi.spyOn(api, 'deleteAsset').mockResolvedValue({ ok: true, trashedAt: 5, usedIn: 3 })
    const restore = vi.spyOn(api, 'restoreAsset').mockResolvedValue(clip('as_1'))
    show('/library?tab=assets')
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for as_1.mov' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Move to trash/ }))
    const dialog = await screen.findByRole('dialog', { name: /Move “as_1\.mov” to the trash/ })
    await waitFor(() => expect(dialog.textContent).toMatch(/Used in 2 projects: “Launch”, “Teaser”\./))
    expect(dialog.textContent).toMatch(/keep playing it while it’s in the trash/)
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Move to trash' })))
    expect(del).toHaveBeenCalledWith('as_1')
    expect(screen.queryByRole('button', { name: 'Preview as_1.mov' })).toBeNull()
    const t = useToasts.getState().toasts.at(-1)!
    expect(t.text).toBe('Moved to the trash')
    await act(async () => t.action!.run())
    expect(restore).toHaveBeenCalledWith('as_1')
    expect(await screen.findByRole('button', { name: 'Preview as_1.mov' })).toBeTruthy()
  })

  it('the media trash restores, and Empty trash says what breaks before removing for good', async () => {
    useSystem.setState({ info: { mode: 'cloud', version: '1', ai: { provider: 'none', available: false, detail: '' }, capabilities: { transcribe: false, tts: false, render: false }, retention: { mediaTrashDays: 30, exportDays: 0 } } })
    const assets = vi.spyOn(api, 'assets').mockImplementation(async (_w, _k, o) => (o?.trashed ? [clip('as_t1', { trashedAt: 2 }), clip('as_t2', { trashedAt: 3 })] : []))
    vi.spyOn(api, 'assetUsage').mockImplementation(async (id) => ({ assetId: id, projects: id === 'as_t1' ? [{ id: 'p', name: 'Launch', trashed: false }] : [] }))
    const restore = vi.spyOn(api, 'restoreAsset').mockResolvedValue(clip('as_t2'))
    const empty = vi.spyOn(api, 'emptyTrash').mockResolvedValue({ removed: 1, exports: 0 })
    show('/library?tab=trash&show=media')
    const table = await screen.findByRole('table', { name: 'Media in the trash' })
    expect(assets).toHaveBeenCalledWith('ws_me', undefined, { trashed: true })
    expect(screen.getByRole('note').textContent).toMatch(/deleted for good after 30 days/)
    await waitFor(() => expect(within(table).getAllByRole('row')[2].textContent).toMatch(/1 project/))
    fireEvent.click(screen.getByRole('button', { name: 'Restore as_t2.mov' }))
    await waitFor(() => expect(restore).toHaveBeenCalledWith('as_t2'))
    await waitFor(() => expect(screen.queryByText('as_t2.mov')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /Empty trash/ }))
    const dialog = screen.getByRole('alertdialog', { name: /Empty the trash \(1 clip\)/ })
    expect(dialog.textContent).toMatch(/1 clip is still used in projects, which will show it as missing/)
    expect(dialog.textContent).toMatch(/can’t be undone/)
    expect(document.activeElement?.textContent).toBe('Cancel')
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Empty trash' })))
    expect(empty).toHaveBeenCalledWith('ws_me', undefined)
    expect(await screen.findByText('No media in the trash')).toBeTruthy()
  })

  it('a viewer can look at the trash but not restore or empty it', async () => {
    useSession.setState({ workspaces: [{ ...ws, role: 'viewer' }] })
    vi.spyOn(api, 'assets').mockResolvedValue([clip('as_t1', { trashedAt: 2 })])
    vi.spyOn(api, 'assetUsage').mockResolvedValue({ assetId: 'as_t1', projects: [] })
    show('/library?tab=trash&show=media')
    expect(((await screen.findByRole('button', { name: 'Restore as_t1.mov' })) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Empty trash/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the media preview (A-15)', () => {
  it('steps through the clips with the arrow keys and buttons, and shows the transcript', async () => {
    const said = { language: 'en', engine: 't', segments: [{ start: 4, end: 6, text: 'Welcome to the tour', words: [] }] }
    vi.spyOn(api, 'assets').mockResolvedValue([clip('as_1', { transcriptRev: 'r1', light: true }), clip('as_2'), clip('as_3', {}, { kind: 'image' })])
    vi.spyOn(api, 'asset').mockResolvedValue(clip('as_1', {}, { transcript: said }))
    show('/library?tab=assets')
    fireEvent.click(await screen.findByRole('button', { name: 'Preview as_1.mov' }))
    let dialog = screen.getByRole('dialog', { name: 'as_1.mov' })
    expect(dialog.textContent).toMatch(/1 of 3/)
    expect(await within(dialog).findByRole('button', { name: /Play from 0:04: Welcome to the tour/ })).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Next: as_2.mov' }), { key: 'ArrowRight' })
    dialog = screen.getByRole('dialog', { name: 'as_2.mov' })
    expect(within(dialog).getByText(/No transcript yet/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next: as_3.mov' }))
    dialog = screen.getByRole('dialog', { name: 'as_3.mov' })
    expect((within(dialog).getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Previous: as_2.mov' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('dialog', { name: 'as_2.mov' })).toBeTruthy()
  })

  it('“Use in a new project” makes a project with the clip on its timeline and opens it', async () => {
    vi.spyOn(api, 'assets').mockResolvedValue([clip('as_1', {}, { width: 1080, height: 1920 })])
    const create = vi.spyOn(api, 'createProject').mockResolvedValue({ summary: { id: 'p_new' }, project: {}, version: 1 } as never)
    show('/library?tab=assets')
    fireEvent.click(await screen.findByRole('button', { name: 'Preview as_1.mov' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Use in a new project/ })))
    const body = create.mock.calls[0][0]
    expect(body.workspaceId).toBe('ws_me')
    expect(body.project).toMatchObject({ name: 'as_1', width: 1080, height: 1920 })
    expect(Object.keys(body.project!.assets)).toEqual(['as_1'])
    expect(body.project!.tracks.flatMap((t) => t.items).map((i) => (i as { assetId?: string }).assetId)).toEqual(['as_1'])
    expect(await screen.findByTestId('where')).toBeTruthy()
    expect(screen.getByTestId('where').textContent).toBe('/edit/p_new')
  })

  it('a search hit’s ?preview= opens the clip, and leaves the URL', async () => {
    vi.spyOn(api, 'assets').mockResolvedValue([clip('as_1'), clip('as_2')])
    show('/library?tab=assets&preview=as_2&at=12')
    expect(await screen.findByRole('dialog', { name: 'as_2.mov' })).toBeTruthy()
  })
})

describe('replacing a file (A-14)', () => {
  it('uploads the new file under the clip’s id; another kind of file is refused here', async () => {
    vi.spyOn(api, 'assets').mockResolvedValue([clip('as_1')])
    const replace = vi.spyOn(api, 'replaceAsset').mockResolvedValue(clip('as_1', { status: 'processing' }))
    show('/library?tab=assets')
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for as_1.mov' }))
    // the replace picker takes one file (the upload picker takes several)
    const input = [...document.querySelectorAll<HTMLInputElement>('input[type=file]')].find((i) => !i.multiple)!
    fireEvent.click(screen.getByRole('menuitem', { name: /Replace file/ }))
    const song = new File(['x'], 'song.mp3', { type: 'audio/mpeg' })
    fireEvent.change(input, { target: { files: [song] } })
    expect(replace).not.toHaveBeenCalled()
    expect(useToasts.getState().toasts.at(-1)!.text).toMatch(/Pick a video file/)
    const take = new File(['x'], 'take2.mp4', { type: 'video/mp4' })
    fireEvent.change(input, { target: { files: [take] } })
    await waitFor(() => expect(replace).toHaveBeenCalledWith('as_1', take, expect.any(Function)))
    expect(await screen.findByText(/Processing…/)).toBeTruthy()
  })
})
