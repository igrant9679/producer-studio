// APP-38: menus, tab strips and card pickers work from the keyboard; Library list rows open; icon links are named.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ExportRecord, ProjectSummary, Workspace } from '@producer/core'
import { useState } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import ExportsPage from '../pages/ExportsPage'
import LibraryPage from '../pages/LibraryPage'
import { MenuList, Popover, RadioCards, TabPanel, Tabs } from '../ui'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ws: Workspace = { id: 'ws_me', name: "Sam's space", role: 'owner', personal: true, memberCount: 1 }
const project = { id: 'p_1', workspaceId: ws.id, name: 'Launch cut', kind: 'edit', width: 1920, height: 1080, duration: 30, createdAt: 0, updatedAt: Date.now(), trashed: false, isTemplate: false } as ProjectSummary

describe('the Library list view', () => {
  it('opens a row from the keyboard, through its name', async () => {
    localStorage.setItem('ps.libraryView', 'list')
    useSession.setState({ status: 'ready', workspaces: [ws], workspaceId: ws.id })
    vi.spyOn(api, 'projects').mockResolvedValue([project])
    render(
      <MemoryRouter initialEntries={['/library']}>
        <Routes>
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/edit/:id" element={<p>editor open</p>} />
        </Routes>
      </MemoryRouter>,
    )
    const open = await screen.findByRole('button', { name: 'Launch cut' })
    expect(screen.getByRole('tabpanel', { name: 'Projects' }).contains(open)).toBe(true)
    fireEvent.click(open)
    expect(await screen.findByText('editor open')).toBeTruthy()
    localStorage.removeItem('ps.libraryView')
  })
})

describe('the Exports page', () => {
  it('names its open-in-a-new-tab link', async () => {
    useSession.setState({ status: 'ready', workspaces: [ws], workspaceId: ws.id })
    vi.spyOn(api, 'projects').mockResolvedValue([project])
    vi.spyOn(api, 'exports').mockResolvedValue([{ exportId: 'ex_1', projectId: 'p_1', name: 'Launch cut', url: '/x.mp4', resolution: '1080p', fps: 30, createdAt: 0, sizeBytes: 1, duration: 30 } as unknown as ExportRecord])
    vi.spyOn(api, 'shares').mockResolvedValue([])
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }))
    render(
      <MemoryRouter>
        <ExportsPage />
      </MemoryRouter>,
    )
    expect((await screen.findByRole('link', { name: 'Open Launch cut in a new tab' })).getAttribute('href')).toBe('/x.mp4')
  })
})

function Menu({ onPick }: { onPick: (l: string) => void }) {
  return (
    <Popover trigger={({ toggle, open }) => <button onClick={toggle} aria-expanded={open} aria-haspopup="menu">More actions</button>}>
      {(close) => (
        <MenuList
          close={close}
          label="Project"
          items={[
            { label: 'Open', onClick: () => onPick('Open') },
            { label: 'Rename', onClick: () => onPick('Rename') },
            { label: 'Duplicate', disabled: true, tip: 'Only owners and editors…' },
            { sep: true, label: '' },
            { label: 'Move to trash', danger: true, onClick: () => onPick('Move to trash') },
          ]}
        />
      )}
    </Popover>
  )
}

describe('menus', () => {
  it('focus their first item on open and move with the arrow keys, Home and End, skipping disabled items', () => {
    render(<Menu onPick={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    const item = (name: string) => screen.getByRole('menuitem', { name })
    expect(screen.getByRole('menu', { name: 'Project' })).toBeTruthy()
    expect(document.activeElement).toBe(item('Open'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Rename'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Move to trash'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Open'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('Move to trash'))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(item('Open'))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(item('Move to trash'))
    expect(item('Duplicate').getAttribute('data-tip')).toBe('Only owners and editors…')
  })

  it('close on Escape and give focus back to their button', () => {
    render(<Menu onPick={() => undefined} />)
    const trigger = screen.getByRole('button', { name: 'More actions' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('run the chosen item and give focus back to their button', () => {
    const onPick = vi.fn()
    render(<Menu onPick={onPick} />)
    const trigger = screen.getByRole('button', { name: 'More actions' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.click(document.activeElement!)
    expect(onPick).toHaveBeenCalledWith('Rename')
    expect(document.activeElement).toBe(trigger)
  })
})

function Strip() {
  const [tab, setTab] = useState<'projects' | 'assets' | 'trash'>('projects')
  return (
    <>
      <Tabs id="lib" label="Library" value={tab} onChange={setTab} tabs={[{ id: 'projects', label: 'Projects' }, { id: 'assets', label: 'Assets' }, { id: 'trash', label: 'Trash' }]} />
      <TabPanel tabs="lib" value={tab}>
        <p>{tab} content</p>
      </TabPanel>
    </>
  )
}

describe('tab strips', () => {
  it('are one tab stop whose selected tab names its panel', () => {
    render(<Strip />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1])
    const panel = screen.getByRole('tabpanel', { name: 'Projects' })
    expect(panel.textContent).toBe('projects content')
    expect(tabs[0].getAttribute('aria-controls')).toBe(panel.id)
  })

  it('move and select with the arrow keys, Home and End', () => {
    render(<Strip />)
    const tab = (name: string) => screen.getByRole('tab', { name })
    tab('Projects').focus()
    fireEvent.keyDown(tab('Projects'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('Assets'))
    expect(tab('Assets').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: 'Assets' }).textContent).toBe('assets content')
    fireEvent.keyDown(tab('Assets'), { key: 'End' })
    expect(document.activeElement).toBe(tab('Trash'))
    fireEvent.keyDown(tab('Trash'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('Projects'))
    fireEvent.keyDown(tab('Projects'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tab('Trash'))
    fireEvent.keyDown(tab('Trash'), { key: 'Home' })
    expect(tab('Projects').getAttribute('aria-selected')).toBe('true')
  })
})

function Voices({ initial }: { initial?: string }) {
  const [sel, setSel] = useState(initial)
  return (
    <RadioCards label="Voices">
      {['Heart', 'Bella', 'Adam'].map((v) => (
        <div key={v} role="radio" aria-checked={sel === v} tabIndex={0} aria-label={v} onClick={() => setSel(v)}>
          {v}
          <button aria-label={`Play ${v}`}>▶</button>
        </div>
      ))}
    </RadioCards>
  )
}

describe('radio cards (voice pickers)', () => {
  it('are one tab stop, on the checked card, and only its Play button is reachable', () => {
    render(<Voices initial="Bella" />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1])
    expect(['Heart', 'Bella', 'Adam'].map((v) => screen.getByRole('button', { name: `Play ${v}` }).tabIndex)).toEqual([-1, 0, -1])
  })

  it('fall back to the first card when none is checked', () => {
    render(<Voices />)
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1])
  })

  it('move and select with the arrow keys', () => {
    render(<Voices initial="Heart" />)
    const radio = (name: string) => screen.getByRole('radio', { name })
    radio('Heart').focus()
    fireEvent.keyDown(radio('Heart'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(radio('Bella'))
    expect(radio('Bella').getAttribute('aria-checked')).toBe('true')
    expect(radio('Bella').tabIndex).toBe(0)
    expect(radio('Heart').tabIndex).toBe(-1)
    fireEvent.keyDown(radio('Bella'), { key: 'ArrowUp' })
    expect(radio('Heart').getAttribute('aria-checked')).toBe('true')
  })
})
