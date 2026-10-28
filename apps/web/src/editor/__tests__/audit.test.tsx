// The accessibility audit (R3-E): every control in the editor has a name a screen reader can say (each clip type's
// every Properties tab, each left panel, the top bar and the timeline), save state is said once when it changes,
// and the shared live region doesn't repeat itself.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  addAdjustmentLayer,
  addAsset,
  addItem,
  createAudioItem,
  createCaptionItem,
  createImageItem,
  createProject,
  createShapeItem,
  createTextItem,
  createVideoItem,
  insertTrack,
  type Asset,
  type Project,
} from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { announce, announced, resetAnnouncer } from '../../lib/announce'
import { unnamedControls } from '../../shell/__tests__/audit-helpers'
import { AssetPanel, LeftRail } from '../LeftPanel'
import { PropertiesPanel } from '../PropertiesPanel'
import { startSaveAnnouncements } from '../saveAnnounce'
import { useEditor, type LeftTab } from '../store'
import { Timeline } from '../Timeline'
import { TopBar } from '../TopBar'

vi.setConfig({ testTimeout: 180_000 })
const S = () => useEditor.getState()
const video: Asset = { id: 'a', kind: 'video', name: 'talk.mp4', src: '/api/media/a/source', duration: 30, width: 1920, height: 1080, hasAudio: true }
const still: Asset = { id: 'img', kind: 'image', name: 'logo.png', src: '/api/media/img/source', width: 400, height: 400 }
const music: Asset = { id: 'au', kind: 'audio', name: 'bed.mp3', src: '/api/media/au/source', duration: 30 }

function everything(): { project: Project; ids: Record<string, string> } {
  let p = createProject({ id: 'p1', name: 'Audit' })
  for (const a of [video, still, music]) p = addAsset(p, a)
  p = addItem(p, createVideoItem(video, 0, { id: 'v' }))
  p = addItem(p, createImageItem(still, 0, { id: 'i', duration: 4 }))
  p = addItem(p, createTextItem(0, 'heading', { id: 't' }))
  p = addItem(p, createShapeItem(0, { id: 's' }))
  p = addItem(p, createAudioItem(music, 0, { id: 'm' }))
  insertTrack(p, 'caption').items.push({ ...createCaptionItem(1, 2, 'Hello there'), id: 'c' })
  const adj = addAdjustmentLayer(p, 1, 2)
  return { project: adj.project, ids: { video: 'v', image: 'i', text: 't', shape: 's', audio: 'm', caption: 'c', adjustment: adj.id } }
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
  Element.prototype.scrollIntoView ??= () => undefined
  Element.prototype.scrollTo ??= (() => undefined) as never
})
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetAnnouncer()
})

describe('every editor control has a name', () => {
  it('(the check finds an icon-only button, a bare select and a placeholder-only box)', () => {
    render(
      <div>
        <button><svg /></button>
        <button aria-label="Close"><svg /></button>
        <select><option>One</option></select>
        <textarea placeholder="" />
      </div>,
    )
    expect(unnamedControls()).toHaveLength(3)
  })

  it('in every Properties tab of every kind of clip', () => {
    const { project, ids } = everything()
    S().load({ project, version: 1, projectId: 'p1', demo: true })
    render(<PropertiesPanel />)
    const missing: string[] = []
    const check = (where: string) => missing.push(...unnamedControls().map((m) => `${where}: ${m}`))
    check('project')
    for (const [kind, id] of Object.entries(ids)) {
      act(() => S().select([id]))
      for (const name of within(screen.getByRole('tablist', { name: 'Properties' })).getAllByRole('tab').map((t) => t.textContent!)) {
        fireEvent.click(screen.getByRole('tab', { name }))
        check(`${kind} · ${name}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('in every left panel, the top bar and the timeline', () => {
    const { project } = everything()
    S().load({ project, version: 1, projectId: 'p1', demo: true })
    render(
      <MemoryRouter>
        <TopBar />
        <LeftRail />
        <AssetPanel />
        <Timeline />
      </MemoryRouter>,
    )
    const missing: string[] = unnamedControls().map((m) => `start: ${m}`)
    const tabs: LeftTab[] = ['media', 'audio', 'text', 'captions', 'transcript', 'effects', 'transitions', 'filters', 'brand', 'comments', 'ai']
    for (const tab of tabs) {
      act(() => useEditor.setState({ activeLeftTab: tab, leftCollapsed: false }))
      missing.push(...unnamedControls().map((m) => `${tab}: ${m}`))
    }
    expect(missing).toEqual([])
  })
})

describe('save state is said once when it changes', () => {
  it('quiet while autosave runs; offline and conflict said once each; "All changes saved" after a problem', () => {
    vi.useFakeTimers()
    try {
      S().load({ project: createProject({ id: 'p1' }), version: 1, projectId: 'p1', demo: true })
      const stop = startSaveAnnouncements()
      const to = (saveState: 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict' | 'error') => {
        act(() => useEditor.setState({ saveState }))
        act(() => vi.advanceTimersByTime(100))
      }
      const said: string[] = []
      const note = () => announced() && said.at(-1) !== announced() && said.push(announced())
      for (const st of ['dirty', 'saving', 'saved', 'dirty', 'saving', 'saved'] as const) (to(st), note())
      expect(said).toEqual([])
      // retries while offline go saving → offline again: said once
      for (const st of ['saving', 'offline', 'saving', 'offline', 'saving', 'offline'] as const) (to(st), note())
      expect(said).toEqual(['Offline: your changes are kept in this browser and saved when the server is back'])
      for (const st of ['saving', 'saved'] as const) (to(st), note())
      expect(said.at(-1)).toBe('All changes saved')
      to('conflict')
      note()
      expect(said.at(-1)).toMatch(/saved somewhere else/)
      expect(said).toHaveLength(3)
      // a refused save has its own alert banner: nothing more from here, then saved again once it works
      to('error')
      note()
      expect(said).toHaveLength(3)
      to('saved')
      note()
      expect(said.at(-1)).toBe('All changes saved')
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the live region is one polite status for the app, and the same words within two seconds are not repeated', () => {
    vi.useFakeTimers()
    try {
      announce('Stabilise: started', 1000)
      vi.advanceTimersByTime(100)
      const regions = document.querySelectorAll('[data-announcer]')
      expect(regions).toHaveLength(1)
      expect(regions[0].getAttribute('role')).toBe('status')
      expect(regions[0].getAttribute('aria-live')).toBe('polite')
      expect(announced()).toBe('Stabilise: started')
      regions[0].textContent = ''
      announce('Stabilise: started', 1500)
      vi.advanceTimersByTime(100)
      expect(announced()).toBe('')
      announce('Stabilise: started', 4000)
      vi.advanceTimersByTime(100)
      expect(announced()).toBe('Stabilise: started')
      expect(document.querySelectorAll('[data-announcer]')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
