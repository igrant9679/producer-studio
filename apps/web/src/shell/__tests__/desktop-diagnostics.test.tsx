// Settings → This computer: opt-in crash reports kept locally, and Copy diagnostics (D-14).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { announced } from '../../lib/announce'
import { CrashSettings } from '../pages/DesktopDiagnostics'

afterEach(() => {
  cleanup()
  delete (window as { producerDesktop?: unknown }).producerDesktop
})

describe('crash reports and diagnostics (D-14)', () => {
  it('crash reports are an off-by-default named switch that says nothing is sent', () => {
    const onChange = vi.fn()
    render(<CrashSettings on={false} crash={{ active: false, count: 0 }} onChange={onChange} />)
    const sw = screen.getByRole('switch', { name: 'Keep crash reports on this computer' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/nothing is sent anywhere/)).toBeTruthy()
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('a change waits for the next start, and says so; reports kept are counted', () => {
    const { rerender } = render(<CrashSettings on crash={{ active: false, count: 0 }} onChange={vi.fn()} />)
    expect(screen.getByText(/Takes effect the next time Producer Studio starts/)).toBeTruthy()
    rerender(<CrashSettings on crash={{ active: true, count: 2 }} onChange={vi.fn()} />)
    expect(screen.getByText(/2 kept\./)).toBeTruthy()
  })

  it('Copy diagnostics asks the app, then says and announces it was copied', async () => {
    const copyDiagnostics = vi.fn(async () => ({ ok: true, chars: 9000 }))
    ;(window as { producerDesktop?: unknown }).producerDesktop = { app: { copyDiagnostics } }
    render(<CrashSettings on={false} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Copy diagnostics/ }))
    expect(await screen.findByText(/Diagnostics copied/)).toBeTruthy()
    expect(copyDiagnostics).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(announced()).toMatch(/Diagnostics copied/))
  })

  it('a copy that fails says why; an older app without it shows no button', async () => {
    ;(window as { producerDesktop?: unknown }).producerDesktop = { app: { copyDiagnostics: vi.fn(async () => ({ ok: false, error: 'clipboard busy' })) } }
    const { unmount } = render(<CrashSettings on={false} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Copy diagnostics/ }))
    expect(await screen.findByText(/Couldn’t copy the diagnostics: clipboard busy/)).toBeTruthy()
    unmount()
    ;(window as { producerDesktop?: unknown }).producerDesktop = { app: {} }
    render(<CrashSettings on={false} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Copy diagnostics/ })).toBeNull()
  })
})
