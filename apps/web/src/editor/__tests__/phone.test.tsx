// The editor at phone width (R3-E): the Properties tabs are a tablist whose row scrolls with a cue on the side that
// has more, and the side panels are sheets that open one at a time. The widths themselves need a browser (the
// layout is CSS: the phone block in editor.css); these check the behaviour it hangs on.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, type Asset, type Project } from '@producer/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { scrollCue } from '../PanelTabs'
import { startPhoneSheets } from '../phone'
import { PropertiesPanel } from '../PropertiesPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()
const video = (id: string): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration: 10, width: 1920, height: 1080, hasAudio: true })

function oneClip(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, video('a'))
  return addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
}

let phone = false
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.matchMedia = ((q: string) => ({ matches: q === '(max-width: 760px)' && phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
})
beforeEach(() => {
  phone = false
  S().load({ project: oneClip(), version: 1, projectId: 'p1', demo: true })
  useEditor.setState({ leftCollapsed: false, rightCollapsed: false, versionsOpen: false })
})
afterEach(cleanup)

describe('the Properties tab row', { timeout: 90_000 }, () => {
  it('is a named tablist: one tab stop, arrow keys, Home and End pick a tab, and it names its panel', () => {
    act(() => S().select(['va']))
    render(<PropertiesPanel />)
    const list = screen.getByRole('tablist', { name: 'Properties' })
    const tabs = within(list).getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Basic', 'Colour', 'Canvas', 'Animation', 'Speed', 'Audio', 'Smart'])
    expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1)
    expect(screen.getByRole('tabpanel', { name: 'Basic' })).toBeTruthy()
    act(() => tabs[0].focus())
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
    expect(S().activeRightTab).toBe('adjust')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Colour' }))
    expect(screen.getByRole('tab', { name: 'Colour' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: 'Colour' })).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(S().activeRightTab).toBe('smart')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(S().activeRightTab).toBe('basic')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Smart' }))
    // the collapse button is outside the tablist
    expect(within(list).queryByRole('button')).toBeNull()
    expect(screen.getByRole('button', { name: 'Collapse panel' })).toBeTruthy()
  })

  it('says which side has more tabs when the row scrolls', () => {
    expect(scrollCue({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 })).toBe('')
    expect(scrollCue({ scrollLeft: 0, clientWidth: 300, scrollWidth: 380 })).toBe('right')
    expect(scrollCue({ scrollLeft: 40, clientWidth: 300, scrollWidth: 380 })).toBe('both')
    expect(scrollCue({ scrollLeft: 80, clientWidth: 300, scrollWidth: 380 })).toBe('left')
  })

  it('marks the row as it scrolls, and keeps the chosen tab in view', () => {
    act(() => S().select(['va']))
    const seen: Element[] = []
    const into = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      seen.push(this)
    }
    try {
      render(<PropertiesPanel />)
      const list = screen.getByRole('tablist', { name: 'Properties' })
      Object.defineProperty(list, 'clientWidth', { configurable: true, value: 300 })
      Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 380 })
      fireEvent.scroll(list)
      expect(list.dataset.more).toBe('right')
      list.scrollLeft = 80
      fireEvent.scroll(list)
      expect(list.dataset.more).toBe('left')
      fireEvent.click(screen.getByRole('tab', { name: 'Smart' }))
      expect(seen.at(-1)).toBe(screen.getByRole('tab', { name: 'Smart' }))
    } finally {
      HTMLElement.prototype.scrollIntoView = into
    }
  })
})

describe('panels as sheets on a phone', () => {
  it('opens with both panels closed, and opening one side closes the other', () => {
    phone = true
    const stop = startPhoneSheets()
    try {
      expect(S().leftCollapsed).toBe(true)
      expect(S().rightCollapsed).toBe(true)
      act(() => useEditor.setState({ activeLeftTab: 'comments', leftCollapsed: false }))
      act(() => useEditor.setState({ rightCollapsed: false }))
      expect(S().leftCollapsed).toBe(true)
      act(() => useEditor.setState({ leftCollapsed: false }))
      expect(S().rightCollapsed).toBe(true)
      // version history closes the left panel; the left panel doesn't close version history (that ends a preview)
      act(() => useEditor.setState({ versionsOpen: true }))
      expect(S().leftCollapsed).toBe(true)
      act(() => useEditor.setState({ leftCollapsed: false }))
      expect(S().versionsOpen).toBe(true)
    } finally {
      stop()
    }
  })

  it('leaves a wide screen as it is: both panels open side by side', () => {
    const stop = startPhoneSheets()
    try {
      expect(S().leftCollapsed).toBe(false)
      expect(S().rightCollapsed).toBe(false)
      act(() => useEditor.setState({ leftCollapsed: true }))
      act(() => useEditor.setState({ leftCollapsed: false }))
      expect(S().rightCollapsed).toBe(false)
    } finally {
      stop()
    }
  })
})
