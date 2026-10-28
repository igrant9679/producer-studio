// E-3: automatic merging of edits that don't overlap, and the Version history panel (preview, restore, name).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { addItem, createProject, createShapeItem, updateProject, type Project, type ProjectSummary, type ProjectVersionSummary } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Canvas } from '../Canvas'
import { flush, onProjectEvent, startAutosave } from '../persistence'
import { useEditor } from '../store'
import { TopBar } from '../TopBar'
import { VersionPreviewBanner, VersionsPanel } from '../VersionsPanel'

const S = () => useEditor.getState()
const BASE: Project = { ...createProject({ id: 'p1', name: 'Launch' }), createdAt: 1, updatedAt: 1 }
const summary = { id: 'p1', workspaceId: 'w1' } as ProjectSummary
const team = (role: 'editor' | 'viewer') => useSession.setState({ status: 'ready', user: { id: 'u1', name: 'Dana' }, workspaces: [{ id: 'w1', name: 'Team', role, personal: false, memberCount: 2 }], workspaceId: 'w1' } as never)

let stop: () => void
beforeEach(() => {
  localStorage.clear()
  team('editor')
  S().load({ project: BASE, version: 3, projectId: 'p1', demo: false, workspaceId: 'w1' })
  stop = startAutosave()
})
afterEach(() => {
  stop()
  cleanup()
  vi.restoreAllMocks()
})

describe('saving over a version saved elsewhere', () => {
  it('merges edits that don’t overlap and saves the result, with no conflict to decide', async () => {
    const theirs = { ...BASE, name: 'Launch (final)' }
    const save = vi
      .spyOn(api, 'saveProject')
      .mockRejectedValueOnce(new HttpError(409, { error: 'conflict', details: { version: 4, project: theirs } }))
      .mockResolvedValueOnce({ version: 5, updatedAt: 1 })
    S().commit(updateProject(S().project, { background: '#336699' }), 'Background')
    await flush()
    expect(S().saveState).toBe('dirty')
    expect(S().project).toMatchObject({ name: 'Launch (final)', background: '#336699' })
    // undo still undoes only my change, on top of theirs
    expect(S().history.past.at(-1)?.project.name).toBe('Launch (final)')
    await flush()
    expect(save).toHaveBeenLastCalledWith('p1', expect.objectContaining({ name: 'Launch (final)', background: '#336699' }), 4)
    expect(S()).toMatchObject({ saveState: 'saved', version: 5 })
  })

  it('asks only when both changed the same thing, and says what', async () => {
    vi.spyOn(api, 'saveProject').mockRejectedValueOnce(new HttpError(409, { error: 'conflict', details: { version: 4, project: { ...BASE, background: '#ff0000' } } }))
    S().commit(updateProject(S().project, { background: '#336699' }), 'Background')
    await flush()
    expect(S()).toMatchObject({ saveState: 'conflict', conflictVersion: 4, conflictWhat: 'the background colour' })
    expect(S().project.background).toBe('#336699')
  })

  it('a live update while editing merges too', async () => {
    vi.spyOn(api, 'project').mockResolvedValue({ project: { ...BASE, name: 'Renamed in the Library' }, version: 4, summary })
    S().commit(updateProject(S().project, { background: '#336699' }), 'Background')
    await onProjectEvent({ id: 'p1', version: 4 })
    expect(S()).toMatchObject({ saveState: 'dirty', version: 4 })
    expect(S().project).toMatchObject({ name: 'Renamed in the Library', background: '#336699' })
  })
})

const versions: ProjectVersionSummary[] = [
  { id: 'pv3', version: 3, label: 'autosave', sizeBytes: 2048, createdAt: Date.now() - 60_000, authorName: 'Dana', current: true },
  { id: 'pv2', version: 2, label: 'named', name: 'Sent to client', sizeBytes: 2048, createdAt: Date.now() - 3_600_000, authorName: 'Sam' },
  { id: 'pv1', version: 1, label: 'before-ai', note: 'Producer AI assembly', sizeBytes: 1024, createdAt: Date.now() - 7_200_000, authorName: 'Sam' },
]

function panel() {
  vi.spyOn(api, 'versions').mockResolvedValue(versions)
  useEditor.setState({ versionsOpen: true })
  return render(
    <MemoryRouter>
      <TopBar />
      <VersionPreviewBanner />
      {S().versionsOpen && <VersionsPanel />}
    </MemoryRouter>,
  )
}

describe('the Version history panel', { timeout: 20_000 }, () => {
  it('opens from the top bar and lists versions with who, when, size and why', async () => {
    vi.spyOn(api, 'versions').mockResolvedValue(versions)
    const r = render(<MemoryRouter><TopBar /></MemoryRouter>)
    const btn = screen.getByRole('button', { name: 'Version history' })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn)
    expect(S().versionsOpen).toBe(true)
    r.rerender(<MemoryRouter><TopBar /><VersionsPanel /></MemoryRouter>)
    const list = await screen.findByRole('list')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toMatch(/Current/)
    expect(items[1].textContent).toMatch(/Sent to client.*Sam/)
    expect(items[2].textContent).toMatch(/Before AI.*Producer AI assembly/)
    // the current one has nothing to preview or restore
    expect(within(items[0]).queryByRole('button', { name: /Restore/ })).toBeNull()
  })

  it('previews a version read-only on the canvas, and Escape goes back to the current one, then closes', async () => {
    const old = { ...BASE, background: '#999999' }
    vi.spyOn(api, 'version').mockResolvedValue({ project: old, summary: versions[1] })
    panel()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview “Sent to client”' }))
    await waitFor(() => expect(S().versionPreview?.project.background).toBe('#999999'))
    expect(screen.getByRole('status').textContent).toMatch(/Previewing “Sent to client” \(read-only\)/)
    // the document itself is untouched
    expect(S().project.background).toBe('#000000')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(S().versionPreview).toBeUndefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(S().versionsOpen).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Version history' }))
  })

  it('the canvas draws the version on show, and takes no clicks while it does', () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
    const old = addItem(BASE, createShapeItem(0, { id: 'old_shape', duration: 5 }))
    const { container } = render(<Canvas />)
    const layer = () => container.querySelector('.cv-stage [data-ps-layer="old_shape"]')
    expect(layer()).toBeNull()
    act(() => useEditor.setState({ versionPreview: { id: 'pv2', label: '“Sent to client”', project: old } }))
    expect(layer()).not.toBeNull()
    document.elementsFromPoint = () => [layer()!]
    fireEvent.pointerDown(container.querySelector('.cv-wrap')!, { button: 0, clientX: 10, clientY: 10 })
    expect(S().selection).toEqual([])
    act(() => useEditor.setState({ versionPreview: undefined }))
    expect(layer()).toBeNull()
  })

  it('an edit ends a preview', async () => {
    vi.spyOn(api, 'version').mockResolvedValue({ project: { ...BASE, background: '#999999' }, summary: versions[1] })
    vi.spyOn(api, 'saveProject').mockResolvedValue({ version: 4, updatedAt: 1 })
    panel()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview “Sent to client”' }))
    await waitFor(() => expect(S().versionPreview).toBeTruthy())
    act(() => S().commit(updateProject(S().project, { name: 'Edited' }), 'Rename'))
    expect(S().versionPreview).toBeUndefined()
  })

  it('restores after a confirmation: saves first, then opens the restored version', async () => {
    const restored = { ...BASE, background: '#999999' }
    const save = vi.spyOn(api, 'saveProject').mockResolvedValue({ version: 4, updatedAt: 1 })
    const restore = vi.spyOn(api, 'restoreVersion').mockResolvedValue({ version: 5, updatedAt: 2 })
    vi.spyOn(api, 'project').mockResolvedValue({ project: restored, version: 5, summary })
    panel()
    act(() => S().commit(updateProject(S().project, { name: 'Unsaved edit' }), 'Rename'))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore “Sent to client”' }))
    const dialog = screen.getByRole('dialog', { name: 'Restore “Sent to client”?' })
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' })))
    await waitFor(() => expect(S().version).toBe(5))
    // the unsaved edit was saved first (it is the "before restore" version), then the restore went on top of it
    expect(save).toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'Unsaved edit' }), 3)
    expect(restore).toHaveBeenCalledWith('p1', 'pv2', 4)
    expect(S()).toMatchObject({ saveState: 'saved', project: { background: '#999999' } })
  })

  it('names the current version', async () => {
    const name = vi.spyOn(api, 'nameCurrentVersion').mockResolvedValue({ ...versions[0], label: 'named', name: 'Approved' })
    panel()
    fireEvent.click(await screen.findByRole('button', { name: /Name the current version/ }))
    const input = screen.getByRole('textbox', { name: 'Name for what’s on screen now' })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'Approved' } })
    await act(async () => fireEvent.submit(input.closest('form')!))
    expect(name).toHaveBeenCalledWith('p1', 'Approved')
  })

  it('a viewer can look but not restore or name', async () => {
    team('viewer')
    panel()
    const restore = await screen.findByRole('button', { name: 'Restore “Sent to client”' })
    expect((restore as HTMLButtonElement).disabled).toBe(true)
    expect(restore.getAttribute('data-tip')).toMatch(/viewer/)
    expect((screen.getByRole('button', { name: /Name the current version/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Preview “Sent to client”' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
