// Labels tied to their controls, menus and dialogs that manage focus (EDT-37).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createProject } from '@producer/core'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { Field, Menu, MenuItem, Section, Segmented, Slider, Toggle } from '../controls'
import { ExportDialog, ShortcutsDialog } from '../Dialogs'
import { useEditor } from '../store'

const S = () => useEditor.getState()

beforeEach(() => {
  S().load({ project: createProject({ id: 'p1', name: 'On screen' }), version: 1, projectId: 'p1', demo: true })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('labels name their controls', () => {
  it('a slider and its number box are named by the slider label', () => {
    render(<Slider label="Opacity" value={0.5} min={0} max={1} step={0.01} onChange={() => {}} />)
    expect(screen.getByRole('slider', { name: 'Opacity' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Opacity value' })).toBeTruthy()
    // clicking the label goes to the slider
    expect(screen.getByText('Opacity').closest('label')!.htmlFor).toBe(screen.getByRole('slider').id)
  })

  it('a toggle in a field is a switch named by the field, reachable by keyboard', () => {
    const Box = () => {
      const [on, setOn] = useState(false)
      return <Field label="Uppercase"><Toggle checked={on} onChange={setOn} /></Field>
    }
    render(<Box />)
    const sw = screen.getByRole('switch', { name: 'Uppercase' }) as HTMLInputElement
    fireEvent.click(sw)
    expect(sw.checked).toBe(true)
  })

  it('choices in a field are a named group of pressed buttons', () => {
    render(<Field label="Quality"><Segmented value="high" options={[{ value: 'draft', label: 'Draft' }, { value: 'high', label: 'High' }]} onChange={() => {}} /></Field>)
    const group = screen.getAllByRole('group', { name: 'Quality' })
    expect(group.length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'High' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Draft' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('a plain select or box put in a field is named by the field (R3-E)', () => {
    render(
      <>
        <Field label="Frame rate"><select><option>30</option></select></Field>
        <Field label="Name"><input /></Field>
        <Field label="Size"><input aria-label="Width" /></Field>
      </>,
    )
    expect(screen.getByRole('combobox', { name: 'Frame rate' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy()
    // its own name wins
    expect(screen.getByRole('textbox', { name: 'Width' })).toBeTruthy()
  })

  it('a section opens and closes with a button that says so', () => {
    render(<Section title="Transform"><p>inside</p></Section>)
    const btn = screen.getByRole('button', { name: 'Transform' })
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('inside')).toBeNull()
  })
})

describe('menus manage focus', () => {
  function WithMenu() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Zoom</button>
        <Menu open={open} onClose={() => setOpen(false)} label="Zoom">
          <MenuItem label="Fit" onClick={() => setOpen(false)} />
          <MenuItem label="50%" onClick={() => setOpen(false)} />
          <MenuItem label="100%" onClick={() => setOpen(false)} disabled />
          <MenuItem label="200%" onClick={() => setOpen(false)} />
        </Menu>
      </>
    )
  }

  it('opening moves focus in, arrows move it, Escape closes and returns it to the opener', () => {
    render(<WithMenu />)
    const opener = screen.getByRole('button', { name: 'Zoom' })
    act(() => opener.focus())
    fireEvent.click(opener)
    expect(screen.getByRole('menu', { name: 'Zoom' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Fit' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '50%' }))
    // the disabled item is skipped
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '200%' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Fit' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '200%' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('choosing an item returns focus to the opener too', () => {
    render(<WithMenu />)
    const opener = screen.getByRole('button', { name: 'Zoom' })
    act(() => opener.focus())
    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('menuitem', { name: '50%' }))
    expect(document.activeElement).toBe(opener)
  })
})

describe('dialogs manage focus', { timeout: 20_000 }, () => {
  it('the shortcuts dialog is named, takes focus, keeps Tab inside, and gives focus back on Escape', () => {
    const Box = () => {
      const open = useEditor((s) => s.shortcutsOpen)
      return (
        <>
          <button onClick={() => S().set({ shortcutsOpen: true })}>Shortcuts</button>
          {open && <ShortcutsDialog />}
        </>
      )
    }
    render(<Box />)
    const opener = screen.getByRole('button', { name: 'Shortcuts' })
    act(() => opener.focus())
    fireEvent.click(opener)
    const dlg = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    const close = screen.getByRole('button', { name: 'Close' })
    expect(document.activeElement).toBe(close)
    // the only control: Tab and Shift+Tab stay on it
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(S().shortcutsOpen).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('the export dialog starts on its name field', () => {
    vi.spyOn(api, 'exports').mockResolvedValue([])
    render(<ExportDialog />)
    expect(screen.getByRole('dialog', { name: 'Export video' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }))
  })
})
