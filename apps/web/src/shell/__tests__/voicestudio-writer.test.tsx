// Voice Studio's AI writer is a proper dialog: focus moves in and stays in, Escape closes it, and focus goes back to
// where it was opened from (carried from R3).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import VoiceStudio from '../pages/VoiceStudio'
import { useTtsDraft } from '../voicestudio/ttsDraft'

vi.mock('../voicestudio/MyVoices', () => ({ MyVoices: () => <div>My voices panel</div> }))
vi.setConfig({ testTimeout: 90_000 })

const ws: Workspace = { id: 'ws_me', name: 'Me', role: 'owner', personal: true, memberCount: 1 }

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaces: [ws], workspaceId: ws.id })
  useTtsDraft.getState().set({ text: '', name: '' })
  vi.spyOn(api, 'assets').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue([])
  vi.spyOn(api, 'brand').mockResolvedValue({ name: 'Me', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const show = () => render(<MemoryRouter initialEntries={['/voice']}><VoiceStudio /></MemoryRouter>)
const script = () => screen.getByLabelText('Voiceover script') as HTMLTextAreaElement

/** Type "/" at the start of the empty script, as a person would to open the writer. */
function typeSlash() {
  const ta = script()
  ta.focus()
  fireEvent.change(ta, { target: { value: '/', selectionStart: 1, selectionEnd: 1 } })
}

describe('the AI writer dialog', () => {
  it('opens from "/" with focus on its prompt, keeps Tab inside, and Escape gives focus back to the script', async () => {
    show()
    typeSlash()
    const dlg = await screen.findByRole('dialog', { name: 'AI writer' })
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    const prompt = within(dlg).getByRole('textbox', { name: 'What should it say?' })
    await waitFor(() => expect(document.activeElement).toBe(prompt))
    // Tab from the last control wraps to the first, Shift+Tab from the first to the last
    const buttons = within(dlg).getAllByRole('button').filter((b) => !(b as HTMLButtonElement).disabled)
    const last = buttons[buttons.length - 1]
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(dlg.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(last)
    // Escape closes it; the "/" that opened it goes, and the script has focus again
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'AI writer' })).toBeNull()
    expect(script().value).toBe('')
    expect(document.activeElement).toBe(script())
  })

  it('opened from its button, Close gives focus back to the button', async () => {
    show()
    fireEvent.change(script(), { target: { value: 'Welcome back to the show.' } })
    const open = screen.getByRole('button', { name: 'AI writer' })
    open.focus()
    fireEvent.click(open)
    const dlg = await screen.findByRole('dialog', { name: 'AI writer' })
    // Rewrite is offered since there is text, and the choice is announced
    const rewrite = within(dlg).getByRole('button', { name: 'Rewrite' })
    fireEvent.click(rewrite)
    expect(rewrite.getAttribute('aria-pressed')).toBe('true')
    expect(within(dlg).getByRole('textbox', { name: 'How should it change?' })).toBeTruthy()
    fireEvent.click(within(dlg).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'AI writer' })).toBeNull()
    expect(document.activeElement).toBe(open)
    expect(script().value).toBe('Welcome back to the show.')
  })

  it('writing closes it and puts focus in the script it writes into', async () => {
    const write = vi.spyOn(api, 'write').mockImplementation(async (_b, onDelta) => {
      onDelta('Hello there.')
    })
    show()
    typeSlash()
    const dlg = await screen.findByRole('dialog', { name: 'AI writer' })
    fireEvent.change(within(dlg).getByRole('textbox', { name: 'What should it say?' }), { target: { value: 'a greeting' } })
    fireEvent.click(within(dlg).getByRole('button', { name: /^Write$/ }))
    expect(screen.queryByRole('dialog', { name: 'AI writer' })).toBeNull()
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ kind: 'voiceover', prompt: 'a greeting' }), expect.any(Function), expect.anything())
    await waitFor(() => expect(script().value).toContain('Hello there.'))
    await waitFor(() => expect(document.activeElement).toBe(script()))
  })
})
