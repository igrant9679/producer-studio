// Settings → This computer: the desktop app's own settings through its preload (D-2 tray; D-4 updates and D-14
// crash reports join them).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announced } from '../../lib/announce'
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

  it('lists the database backups, says how to restore one, and shows their folder (D-10)', async () => {
    const showItemInFolder = vi.fn(async () => true)
    bridge({ ...view, backups: { folder: 'C:\\data\\backups', items: [{ name: 'db-20261028T090507Z-from-0.6.1-schema15', at: Date.now() - 3_600_000, bytes: 52_428_800 }] } })
    ;(window as unknown as { producerDesktop: Record<string, unknown> }).producerDesktop.showItemInFolder = showItemInFolder
    render(<DesktopAppSettings />)
    expect(await screen.findByText('Database backups')).toBeTruthy()
    expect(screen.getByText(/1 kept · newest 1 h ago/)).toBeTruthy()
    expect(screen.getByText(/copy the backup’s “pg” folder in its place/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show backups' }))
    expect(showItemInFolder).toHaveBeenCalledWith('C:\\data\\backups')
  })

  it('with no backup yet it says so and offers no folder', async () => {
    bridge({ ...view, backups: { folder: 'C:\\data\\backups', items: [] } })
    render(<DesktopAppSettings />)
    expect(await screen.findByText(/None yet\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show backups' })).toBeNull()
  })

  it('an older desktop app without these settings shows only the tools', async () => {
    ;(window as { producerDesktop?: unknown }).producerDesktop = { version: '0.6.1', platform: 'win32' }
    render(<DesktopAppSettings />)
    expect(await screen.findByRole('list', { name: 'Bundled tools' })).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})

describe('looking for new versions (D-4)', () => {
  const updates = { offered: true, version: '0.7.0', state: { status: 'idle' as const } }

  it('on an unsigned build the switch is off and says why', async () => {
    bridge({ ...view, updates: { offered: false, reason: 'Update checks come with signed builds, and this one isn’t signed.', version: '0.7.0', state: { status: 'idle' } } })
    render(<DesktopAppSettings />)
    const sw = await screen.findByRole('switch', { name: 'Look for new versions' })
    expect((sw as HTMLButtonElement).disabled).toBe(true)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/this one isn’t signed/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Check now/ })).toBeNull()
  })

  it('Check now finds a newer version, announces it, and Download opens its page', async () => {
    const openExternal = vi.fn(async () => true)
    const checkForUpdates = vi.fn(async () => ({ status: 'available', checkedAt: 1, skipped: false, update: { version: '0.8.0', url: 'https://github.com/o/r/releases/tag/v0.8.0' } }))
    bridge({ ...view, updates }, { checkForUpdates })
    ;(window as unknown as { producerDesktop: Record<string, unknown> }).producerDesktop.openExternal = openExternal
    render(<DesktopAppSettings />)
    expect((await screen.findByRole('switch', { name: 'Look for new versions' })).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/newer version than 0\.7\.0 exists/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Check now/ }))
    expect(await screen.findByText(/Producer Studio 0\.8\.0 is available/)).toBeTruthy()
    await waitFor(() => expect(announced()).toBe('Producer Studio 0.8.0 is available'))
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/releases/tag/v0.8.0')
  })

  it('up to date, or a feed that fails, is said plainly; turning it off is saved', async () => {
    const checkForUpdates = vi.fn().mockResolvedValueOnce({ status: 'current', checkedAt: 1, latest: '0.7.0' }).mockResolvedValueOnce({ status: 'error', checkedAt: 2, error: 'No release has been published yet.' })
    bridge({ ...view, updates }, { checkForUpdates })
    render(<DesktopAppSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Check now/ }))
    expect(await screen.findByText(/You have the latest version \(0\.7\.0\)/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Check now/ }))
    expect(await screen.findByText('No release has been published yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Look for new versions' }))
    await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ updateCheck: false }))
  })
})

describe('older desktop apps', () => {
  it('without these settings show only the tools', async () => {
    ;(window as { producerDesktop?: unknown }).producerDesktop = { version: '0.6.1', platform: 'win32' }
    render(<DesktopAppSettings />)
    expect(await screen.findByRole('list', { name: 'Bundled tools' })).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
