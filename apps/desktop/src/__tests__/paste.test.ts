// Dictation pastes on Linux with wtype (Wayland) or xdotool (X11) when one is installed, on macOS through System
// Events, on Windows as before (D-17).
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { noPasteReason, onPath, pasteCommand } from '../paste'

const has = (...cmds: string[]) => (c: string) => cmds.includes(c)

describe('the paste method per platform (D-17)', () => {
  it('Windows sends Ctrl+V with SendKeys, as before', () => {
    const c = pasteCommand({ platform: 'win32', env: {}, has: has() })!
    expect(c.cmd).toBe('powershell.exe')
    expect(c.args.at(-1)).toContain("SendWait('^v')")
  })

  it('Linux on Wayland uses wtype; on X11 xdotool; an XWayland session falls back to xdotool', () => {
    expect(pasteCommand({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, has: has('wtype', 'xdotool') })).toEqual({ cmd: 'wtype', args: ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'], via: 'wtype' })
    expect(pasteCommand({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' }, has: has('wtype') })?.via).toBe('wtype')
    expect(pasteCommand({ platform: 'linux', env: { DISPLAY: ':0' }, has: has('xdotool', 'wtype') })).toEqual({ cmd: 'xdotool', args: ['key', '--clearmodifiers', 'ctrl+v'], via: 'xdotool' })
    expect(pasteCommand({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, has: has('xdotool') })?.via).toBe('xdotool')
  })

  it('without either the text is left on the clipboard, and the log says what to install', () => {
    expect(pasteCommand({ platform: 'linux', env: { DISPLAY: ':0' }, has: has() })).toBeNull()
    expect(pasteCommand({ platform: 'linux', env: {}, has: has('xdotool') })).toBeNull()
    expect(noPasteReason('linux')).toMatch(/install wtype \(Wayland\) or xdotool \(X11\)/)
  })

  it('macOS asks System Events for Cmd+V (prepared: needs the Accessibility permission)', () => {
    expect(pasteCommand({ platform: 'darwin', env: {}, has: has() })).toMatchObject({ cmd: 'osascript', via: 'System Events', args: ['-e', expect.stringContaining('using command down')] })
  })

  it('finds a program on PATH', () => {
    const dirs = ['/usr/local/bin', '/usr/bin'].join(path.delimiter)
    expect(onPath('xdotool', { PATH: dirs }, (p) => p === path.join('/usr/bin', 'xdotool'))).toBe(true)
    expect(onPath('wtype', { PATH: dirs }, () => false)).toBe(false)
    expect(onPath('wtype', {}, () => true)).toBe(false)
  })
})
