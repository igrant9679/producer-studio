// The media library in Help (19 Nov 2026, the owner: "add the music library to the editor's Help"; 21 Nov: the music
// became AI songs, and a clip library of animations and full-motion clips was added): the editor's Help dialog has a
// Media library tab beside the shortcuts, and the buttons, the Audio tab's tooltip and the app's Help point to it.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { CLIP_LIBRARY, MUSIC_LIBRARY, createProject } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HelpModal } from '../../shell/modals'
import { useSystem } from '../../shell/system'
import { HelpDialog } from '../Dialogs'
import { LeftRail } from '../LeftPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()

beforeEach(() => {
  S().load({ project: createProject({ id: 'p1', name: 'Film' }), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  S().set({ activeLeftTab: 'text', leftCollapsed: true, shortcutsOpen: true })
})
afterEach(() => cleanup())

describe('the editor’s Help', () => {
  it('opens on the shortcuts, with the media library a tab away', () => {
    render(<HelpDialog />)
    const dlg = screen.getByRole('dialog', { name: 'Help' })
    const keys = within(dlg).getByRole('tab', { name: 'Keyboard shortcuts' })
    expect(keys.getAttribute('aria-selected')).toBe('true')
    expect(within(dlg).getByText('Playback')).toBeTruthy()
    // arrow keys move along the tab row
    fireEvent.keyDown(keys, { key: 'ArrowRight' })
    expect(within(dlg).getByRole('tab', { name: 'Media library' }).getAttribute('aria-selected')).toBe('true')
    const panel = within(dlg).getByRole('tabpanel', { name: 'Media library' })
    const text = panel.textContent ?? ''
    expect(text).toContain(`${MUSIC_LIBRARY.length} instrumental songs in different genres (made with Google’s Lyria), 10 animations drawn by AI and 10 full-motion AI video clips`)
    expect(text).toMatch(/Open the Audio tab on the left\. The songs are under Music library/)
    expect(text).toMatch(/Open the Media tab on the left and choose Clip library, then Animations or Full motion/)
    // the panels' icon buttons are shown, and named
    expect(within(panel).getByRole('img', { name: 'Listen' })).toBeTruthy()
    expect(within(panel).getAllByRole('img', { name: 'Add' })).toHaveLength(2)
    expect(within(dlg).queryByText('Playback')).toBeNull()
    expect(CLIP_LIBRARY).toHaveLength(20)
  })

  it('takes you to the music library, or to the clip library', () => {
    const { unmount } = render(<HelpDialog />)
    fireEvent.click(screen.getByRole('tab', { name: 'Media library' }))
    fireEvent.click(screen.getByRole('button', { name: /Open the music library/ }))
    expect(S()).toMatchObject({ activeLeftTab: 'audio', leftCollapsed: false, shortcutsOpen: false })
    unmount()
    S().set({ shortcutsOpen: true, leftCollapsed: true })
    const before = S().clipLibraryAsk
    render(<HelpDialog />)
    fireEvent.click(screen.getByRole('tab', { name: 'Media library' }))
    fireEvent.click(screen.getByRole('button', { name: /Open the clip library/ }))
    expect(S()).toMatchObject({ activeLeftTab: 'media', leftCollapsed: false, shortcutsOpen: false, clipLibraryAsk: before + 1 })
  })

  it('is called Help on the rail, and the Audio tab says the library is there', () => {
    render(<LeftRail />)
    const help = screen.getByRole('button', { name: 'Help (?)' })
    expect(help.getAttribute('data-tip-desc')).toMatch(/media library/)
    fireEvent.click(help)
    expect(S().shortcutsOpen).toBe(true)
    expect(screen.getByRole('button', { name: 'Audio' }).getAttribute('data-tip-desc')).toMatch(/free music library to listen to and add/)
    expect(screen.getByRole('button', { name: 'Media' }).getAttribute('data-tip-desc')).toMatch(/clip library/)
  })
})

describe('the app’s Help', () => {
  it('points to the libraries in the editor', () => {
    useSystem.setState({ info: undefined })
    render(<HelpModal onClose={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'About' }))
    expect(screen.getByRole('tabpanel').textContent).toMatch(new RegExp(`the Audio tab has a music library of ${MUSIC_LIBRARY.length} songs and Media → Clip library has ${CLIP_LIBRARY.length} animations and\\s+full-motion clips`))
  })
})
