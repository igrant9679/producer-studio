// The music library in Help (19 Nov 2026, the owner: "add the music library to the editor's Help"): the editor's Help
// dialog has a Music library tab beside the shortcuts, and the buttons, the Audio tab's tooltip and the app's Help
// point to it.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MUSIC_LIBRARY, createProject } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HelpModal } from '../../shell/modals'
import { useSystem } from '../../shell/system'
import { HelpDialog } from '../Dialogs'
import { LeftRail } from '../LeftPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()

beforeEach(() => {
  S().load({ project: createProject({ id: 'p1', name: 'Film' }), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  S().set({ activeLeftTab: 'media', leftCollapsed: true, shortcutsOpen: true })
})
afterEach(() => cleanup())

describe('the editor’s Help', () => {
  it('opens on the shortcuts, with the music library a tab away', () => {
    render(<HelpDialog />)
    const dlg = screen.getByRole('dialog', { name: 'Help' })
    const keys = within(dlg).getByRole('tab', { name: 'Keyboard shortcuts' })
    expect(keys.getAttribute('aria-selected')).toBe('true')
    expect(within(dlg).getByText('Playback')).toBeTruthy()
    // arrow keys move along the tab row
    fireEvent.keyDown(keys, { key: 'ArrowRight' })
    const music = within(dlg).getByRole('tab', { name: 'Music library' })
    expect(music.getAttribute('aria-selected')).toBe('true')
    const panel = within(dlg).getByRole('tabpanel', { name: 'Music library' })
    expect(panel.textContent).toContain(`${MUSIC_LIBRARY.length} music tracks you can use in any video, free`)
    expect(panel.textContent).toMatch(/Open the Audio tab on the left\. The tracks are under Music library/)
    // the panel's icon buttons are shown, and named
    expect(within(panel).getByRole('img', { name: 'Listen' })).toBeTruthy()
    expect(within(panel).getByRole('img', { name: 'Add' })).toBeTruthy()
    expect(panel.textContent).toMatch(/up to a minute in the desktop app/)
    expect(within(dlg).queryByText('Playback')).toBeNull()
  })

  it('takes you to the library', () => {
    render(<HelpDialog />)
    fireEvent.click(screen.getByRole('tab', { name: 'Music library' }))
    fireEvent.click(screen.getByRole('button', { name: /Open the music library/ }))
    expect(S()).toMatchObject({ activeLeftTab: 'audio', leftCollapsed: false, shortcutsOpen: false })
  })

  it('is called Help on the rail, and the Audio tab says the library is there', () => {
    render(<LeftRail />)
    const help = screen.getByRole('button', { name: 'Help (?)' })
    expect(help.getAttribute('data-tip-desc')).toMatch(/music library/)
    fireEvent.click(help)
    expect(S().shortcutsOpen).toBe(true)
    expect(screen.getByRole('button', { name: 'Audio' }).getAttribute('data-tip-desc')).toMatch(/free music library to listen to and add/)
  })
})

describe('the app’s Help', () => {
  it('points to the library in the editor', () => {
    useSystem.setState({ info: undefined })
    render(<HelpModal onClose={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'About' }))
    expect(screen.getByRole('tabpanel').textContent).toMatch(new RegExp(`the editor’s Audio tab has a music library of ${MUSIC_LIBRARY.length} tracks`))
  })
})
