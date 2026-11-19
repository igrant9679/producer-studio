// "N clips aren't on the timeline · Remove…" in the Media panel (tracker #18), as reported from the live site on
// 19 Nov 2026: the Remove… menu opened below the bottom of the window (its own position lost to the menu's general
// rule, so nothing seemed to happen), the bar counted the project's exports and its AI clips' character pictures as
// unused clips, and a clip moved to the trash stayed on the project's list.
import fs from 'node:fs'
import path from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, unusedAssetIds, usedAssetIds, type Asset, type AssetRecord, type Project } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { AssetPanel } from '../LeftPanel'
import { useEditor } from '../store'
import { useLibrary } from '../uploads'

const S = () => useEditor.getState()
const clip = (id: string, name = `${id}.mp4`): Asset => ({ id, kind: 'video', name, src: `/api/media/${id}/source`, duration: 5, width: 1920, height: 1080 })
const picture = (id: string, name: string): Asset => ({ id, kind: 'image', name, src: `/api/media/${id}/source`, width: 1024, height: 1024 })
const record = (asset: Asset, over: Partial<AssetRecord> = {}): AssetRecord => ({ asset, workspaceId: 'w1', status: 'ready', origin: 'upload', createdAt: 1, projectId: 'p1', ...over })

/** `used` on the timeline; `spare` in the project's media but on no track. */
function project(): Project {
  let p = createProject({ id: 'p1', name: 'Film' })
  p = addAsset(p, clip('used'))
  p = addAsset(p, clip('spare'))
  return addItem(p, createVideoItem(p.assets.used, 0, { id: 'v1' }))
}

function open(records: AssetRecord[]) {
  S().load({ project: project(), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  S().set({ activeLeftTab: 'media', leftCollapsed: false, readOnly: false })
  useLibrary.setState({ records, loaded: true, loading: false, uploads: [] })
  return render(<AssetPanel />)
}

const bar = () => document.querySelector('.ed-unusedbar')

beforeEach(() => {
  vi.restoreAllMocks()
})
afterEach(cleanup)

describe('clips that are not on the timeline', () => {
  it('counts what someone left unused, not what the app keeps: the project’s exports and its characters’ pictures', () => {
    open([
      record(clip('used')),
      record(clip('spare')),
      record(clip('export', 'Film 1080p.mp4'), { origin: 'render' }),
      record(picture('fox', 'Character · the fox'), { origin: 'ai', reference: true }),
    ])
    // all four are this project's media; one is a clip left unused
    expect(screen.getByRole('tab', { name: 'This project · 4' })).toBeTruthy()
    expect(bar()?.textContent).toContain('1 clip isn’t on the timeline')
  })

  it('says nothing when the only media off the timeline is the app’s own', () => {
    S().load({ project: project(), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
    S().commit({ ...S().project, assets: { used: S().project.assets.used } }, 'drop spare')
    useLibrary.setState({ records: [record(clip('used')), record(picture('fox', 'Character · the fox'), { origin: 'ai', reference: true }), record(clip('export', 'Film 1080p.mp4'), { origin: 'render' })], loaded: true, loading: false, uploads: [] })
    S().set({ activeLeftTab: 'media', leftCollapsed: false })
    render(<AssetPanel />)
    expect(screen.getByRole('tab', { name: 'This project · 3' })).toBeTruthy()
    expect(bar()).toBeNull()
  })

  it('the brand logo is in use, as the project itself says', () => {
    const p = { ...project(), brand: { logoAssetId: 'spare' } } as Project
    expect(usedAssetIds(p).has('spare')).toBe(true)
    expect(unusedAssetIds(p)).toEqual([])
  })

  it('Remove… → take it out of the project: off the project’s list, kept in the library', async () => {
    const moved = vi.spyOn(api, 'setAssetProject').mockImplementation(async (id) => record(clip(id), { projectId: undefined }))
    open([record(clip('used')), record(clip('spare'))])
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Take it out of this project/ }))
    await waitFor(() => expect(bar()).toBeNull())
    expect(moved).toHaveBeenCalledWith('spare', null)
    expect(S().project.assets.spare).toBeUndefined()
    expect(screen.getByRole('tab', { name: 'This project · 1' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Library · 2' })).toBeTruthy()
  })

  it('Remove… → move it to the media trash: gone from the project’s list too, not left there as if nothing happened', async () => {
    const trashed = vi.spyOn(api, 'deleteAsset').mockResolvedValue({ ok: true, trashedAt: 5, usedIn: 0 })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    open([record(clip('used')), record(clip('spare'))])
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Move it to the media trash/ }))
    await waitFor(() => expect(bar()).toBeNull())
    expect(trashed).toHaveBeenCalledWith('spare')
    expect(S().project.assets.spare).toBeUndefined()
    expect(screen.getByRole('tab', { name: 'This project · 1' })).toBeTruthy()
    // one step to undo in the project; the trash can put the clip back
    act(() => S().undo())
    expect(S().project.assets.spare).toBeTruthy()
  })

  it('declining the question leaves everything where it was', () => {
    const trashed = vi.spyOn(api, 'deleteAsset').mockResolvedValue({ ok: true, trashedAt: 5, usedIn: 0 })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    open([record(clip('used')), record(clip('spare'))])
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Move it to the media trash/ }))
    expect(trashed).not.toHaveBeenCalled()
    expect(S().project.assets.spare).toBeTruthy()
    expect(bar()?.textContent).toContain('1 clip isn’t on the timeline')
  })
})

describe('menus that sit under their button', () => {
  // `.ed-menu` (position: fixed, for menus placed by the pointer) comes later in the file than these, so a rule of
  // one class loses to it: the menu was fixed at top: 100% of the window, below its bottom edge. jsdom lays nothing
  // out, so the rule is read: a menu class that positions itself must outrank `.ed-menu`.
  const css = fs.readFileSync(path.join(__dirname, '..', 'editor.css'), 'utf8')
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((s) => s.replace(/\/\*[\s\S]*?\*\//g, '').trim()), body: m[2] }))

  it.each(['ed-unusedpop', 'ed-color-pop'])('.%s keeps its own position', (cls) => {
    const own = rules.filter((r) => /position:\s*absolute/.test(r.body) && r.selectors.some((s) => s.includes(`.${cls}`)))
    expect(own.length).toBe(1)
    for (const s of own[0].selectors.filter((x) => x.includes(`.${cls}`))) expect(s === `.ed-menu.${cls}` || /\s/.test(s)).toBe(true)
  })
})
