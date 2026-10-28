// A-24 accessibility basics: a skip link past the navigation, and reduced motion for hover previews and videos that
// start by themselves. The focus rings on cards are CSS (styles/a11y.css) and need a browser to see.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { User, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useAppearance } from '../../lib/appearance'
import { installAutoplayGuard } from '../../lib/motion'
import { useSession } from '../../lib/session'
import { Layout } from '../Layout'
import { SkipLink, Thumb, focusables } from '../ui'

const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const team: Workspace = { id: 'ws_team', name: 'Launch crew', role: 'owner', personal: false, memberCount: 3 }

beforeAll(() => installAutoplayGuard())
beforeEach(() => {
  useSession.setState({ status: 'ready', user: me, workspaces: [team], workspaceId: team.id })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'not here' }), { status: 404 }))
  vi.spyOn(api, 'jobs').mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete document.documentElement.dataset.reduceMotion
  useAppearance.setState({ reduceMotionActive: false })
})

const reduce = (on: boolean) => {
  document.documentElement.dataset.reduceMotion = String(on)
  useAppearance.setState({ reduceMotionActive: on })
}

describe('skip to content', () => {
  it('is the first stop on every shell page and moves focus past the sidebar to the page', () => {
    render(
      <MemoryRouter initialEntries={['/library']}>
        <Layout>
          <h1>Library</h1>
        </Layout>
      </MemoryRouter>,
    )
    const skip = screen.getByRole('link', { name: 'Skip to content' })
    expect(focusables(document.body)[0]).toBe(skip)
    fireEvent.click(skip)
    const main = screen.getByRole('main')
    expect(document.activeElement).toBe(main)
    // focusable by script only: it isn't a Tab stop of its own
    expect(main.tabIndex).toBe(-1)
  })

  it('tries its targets in order (the editor: the timeline’s clip that holds the tab stop, else the timeline)', () => {
    const { rerender } = render(
      <>
        <SkipLink target='.clip[tabindex="0"], .rows'>Skip to the timeline</SkipLink>
        <div className="rows" role="grid" aria-label="Timeline">
          <div className="clip" tabIndex={-1}>a</div>
          <div className="clip" tabIndex={0}>b</div>
        </div>
      </>,
    )
    fireEvent.click(screen.getByRole('link', { name: 'Skip to the timeline' }))
    expect(document.activeElement?.textContent).toBe('b')
    rerender(
      <>
        <SkipLink target='.clip[tabindex="0"], .rows'>Skip to the timeline</SkipLink>
        <div className="rows" role="grid" aria-label="Timeline" />
      </>,
    )
    fireEvent.click(screen.getByRole('link', { name: 'Skip to the timeline' }))
    expect(document.activeElement).toBe(screen.getByRole('grid', { name: 'Timeline' }))
  })
})

describe('reduced motion', () => {
  it('a card’s hover preview plays only when motion is allowed', () => {
    const { container, rerender } = render(<Thumb src="/t.jpg" videoSrc="/p.mp4" playing />)
    expect(container.querySelector('video')).not.toBeNull()
    act(() => reduce(true))
    rerender(<Thumb src="/t.jpg" videoSrc="/p.mp4" playing />)
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('a video that would start by itself waits for play; with motion allowed it starts as before', () => {
    reduce(true)
    const { container } = render(<video src="/a.mp4" autoPlay muted />)
    const v = container.querySelector('video')!
    expect(v.autoplay).toBe(true)
    v.dispatchEvent(new Event('loadstart'))
    expect(v.autoplay).toBe(false)
    // pressing play afterwards is the person's own and isn't stopped
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    v.dispatchEvent(new Event('play'))
    expect(pause).not.toHaveBeenCalled()
    cleanup()

    reduce(false)
    const again = render(<video src="/b.mp4" autoPlay muted />).container.querySelector('video')!
    again.dispatchEvent(new Event('loadstart'))
    expect(again.autoplay).toBe(true)
  })

  it('an autoplay that got going anyway (reduce motion turned on mid-load) is paused once', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const v = render(<video src="/a.mp4" autoPlay muted />).container.querySelector('video')!
    reduce(true)
    v.dispatchEvent(new Event('play'))
    expect(pause).toHaveBeenCalledTimes(1)
    expect(v.autoplay).toBe(false)
  })
})
