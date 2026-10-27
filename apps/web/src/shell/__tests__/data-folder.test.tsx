// Settings → Storage on the desktop app: the data folder moves (the app copies, checks, switches and removes the old
// one) instead of a path field that silently switched to an empty folder at the next start. (DSK-17)
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DesktopSettings } from '@producer/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopStorage } from '../pages/SettingsPage'

const settings = { dataDir: 'C:\\Users\\sam\\AppData\\Local\\Producer Studio\\data', mediaSync: 'on-demand' } as DesktopSettings

afterEach(() => {
  cleanup()
  delete (window as { producerDesktop?: unknown }).producerDesktop
})

describe('the data folder in Settings (DSK-17)', () => {
  it('offers "Move data folder…" in the desktop app, and asks the app to move it', async () => {
    const moveDataFolder = vi.fn(async () => ({ ok: true, dataDir: 'D:\\Producer' }))
    ;(window as { producerDesktop?: unknown }).producerDesktop = { version: '1', platform: 'win32', openExternal: vi.fn(), showItemInFolder: vi.fn(), moveDataFolder }
    const onSettings = vi.fn(async () => undefined)
    render(<DesktopStorage settings={settings} onSettings={onSettings} />)
    const field = screen.getByLabelText('Data folder') as HTMLInputElement
    expect(field.readOnly).toBe(true)
    expect(field.value).toBe(settings.dataDir)
    expect(screen.queryByRole('button', { name: /Change folder/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Move data folder/ }))
    await waitFor(() => expect(moveDataFolder).toHaveBeenCalledTimes(1))
    // the path is never just rewritten in settings
    expect(onSettings).not.toHaveBeenCalledWith(expect.objectContaining({ dataDir: expect.anything() }))
  })

  it('an older desktop app without the move keeps the path field', () => {
    ;(window as { producerDesktop?: unknown }).producerDesktop = { version: '1', platform: 'win32', openExternal: vi.fn(), showItemInFolder: vi.fn() }
    render(<DesktopStorage settings={settings} onSettings={vi.fn(async () => undefined)} />)
    expect(screen.getByRole('button', { name: /Change folder/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Move data folder/ })).toBeNull()
  })
})
