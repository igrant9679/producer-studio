// Settings → This computer: the desktop app's own settings through its preload (D-2 tray; D-4 updates and D-14
// crash reports join them).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopAppSettings, type AppSettingsView } from '../pages/DesktopAppSettings'

const view: AppSettingsView = { keepRunning: false, updateCheck: true, crashReports: false, tray: true }

let setSettings: ReturnType<typeof vi.fn>
function bridge(v: AppSettingsView = view, extra: Record<string, unknown> = {}) {
  let cur = { ...v }
  setSettings = vi.fn(async (p: Partial<AppSettingsView>) => (cur = { ...cur, ...p }))
  ;(window as { producerDesktop?: unknown }).producerDesktop = { version: '0.7.0', platform: 'win32', app: { settings: vi.fn(async () => cur), setSettings, ...extra } }
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ checkedAt: 1, ok: true, tools: [] }), { status: 200 }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as { producerDesktop?: unknown }).producerDesktop
})

describe('keep running in the tray (D-2)', () => {
  it('is a named switch, off by default, that the app saves', async () => {
    bridge()
    render(<DesktopAppSettings />)
    const sw = await screen.findByRole('switch', { name: 'Keep running when the window is closed' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/dictation shortcut and voices the cloud asks this computer for keep working/)).toBeTruthy()
    fireEvent.click(sw)
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'))
    expect(setSettings).toHaveBeenCalledWith({ keepRunning: true })
  })

  it('without a tray (some Linux desktops) it says closing quits and cannot be turned on', async () => {
    bridge({ ...view, tray: false })
    render(<DesktopAppSettings />)
    const sw = await screen.findByRole('switch', { name: 'Keep running when the window is closed' })
    expect((sw as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/no tray, so closing the window quits/)).toBeTruthy()
  })

  it('a refused save says so', async () => {
    bridge()
    setSettings.mockResolvedValueOnce(null)
    render(<DesktopAppSettings />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Keep running when the window is closed' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn’t save that setting/)
  })

  it('an older desktop app without these settings shows only the tools', async () => {
    ;(window as { producerDesktop?: unknown }).producerDesktop = { version: '0.6.1', platform: 'win32' }
    render(<DesktopAppSettings />)
    expect(await screen.findByRole('list', { name: 'Bundled tools' })).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
