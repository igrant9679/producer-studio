// A popover closes when the page changes: the Background jobs popover's Job history link used to leave it open on
// top of the new page (carried from R3). The new page keeps focus; Escape still gives focus back to the trigger.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { User, Workspace } from '@producer/core'
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Layout } from '../Layout'
import { Popover } from '../ui'

const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const team: Workspace = { id: 'ws_team', name: 'Launch crew', role: 'owner', personal: false, memberCount: 3 }

beforeEach(() => {
  useSession.setState({ status: 'ready', user: me, workspaces: [team], workspaceId: team.id })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'not here' }), { status: 404 }))
  vi.spyOn(api, 'jobs').mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Panel() {
  const navigate = useNavigate()
  return (
    <>
      <Popover trigger={({ toggle, open }) => <button onClick={toggle} aria-expanded={open}>Panel</button>}>
        <div role="group" aria-label="Panel body">
          <Link to="/other">Go elsewhere</Link>
        </div>
      </Popover>
      <button onClick={() => navigate('/other')}>Shortcut</button>
    </>
  )
}

function app() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Panel />} />
        <Route path="/other" element={<><Panel /><h1 tabIndex={-1}>Other page</h1></>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Popover closes on navigation', () => {
  it('a link inside it closes it, and focus is not pulled back to the trigger', () => {
    app()
    fireEvent.click(screen.getByRole('button', { name: 'Panel' }))
    const link = screen.getByRole('link', { name: 'Go elsewhere' })
    link.focus()
    fireEvent.click(link)
    expect(screen.getByRole('heading', { name: 'Other page' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Panel body' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Panel' }).getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Panel' }))
  })

  it('a page change from outside it (a shortcut, Back) closes it too', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={<Panel />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Panel' }))
    expect(screen.getByRole('group', { name: 'Panel body' })).toBeTruthy()
    // the same element stays mounted (one route for every path): only the location changes
    fireEvent.click(screen.getByRole('button', { name: 'Shortcut' }))
    expect(screen.queryByRole('group', { name: 'Panel body' })).toBeNull()
  })

  it('Escape still closes it with focus back on its trigger, and it opens again after a page change', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={<Panel />} />
        </Routes>
      </MemoryRouter>,
    )
    const trigger = screen.getByRole('button', { name: 'Panel' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Shortcut' }))
    fireEvent.click(trigger)
    const link = screen.getByRole('link', { name: 'Go elsewhere' })
    link.focus()
    fireEvent.keyDown(link, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Panel body' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('outside a router it works as before', () => {
    render(
      <Popover trigger={({ toggle, open }) => <button onClick={toggle} aria-expanded={open}>Plain</button>}>
        <p>Inside</p>
      </Popover>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Plain' }))
    expect(screen.getByText('Inside')).toBeTruthy()
  })
})

describe('the Background jobs popover', () => {
  it('closes after its Job history link', () => {
    render(
      <MemoryRouter initialEntries={['/library']}>
        <Layout>
          <Routes>
            <Route path="/library" element={<p>library page</p>} />
            <Route path="/jobs" element={<p>job history page</p>} />
          </Routes>
        </Layout>
      </MemoryRouter>,
    )
    const jobs = screen.getByRole('button', { name: /^Background jobs/ })
    fireEvent.click(jobs)
    expect(jobs.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('link', { name: 'Job history' }))
    expect(screen.getByText('job history page')).toBeTruthy()
    expect(jobs.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('link', { name: 'Job history' })).toBeNull()
  })
})
