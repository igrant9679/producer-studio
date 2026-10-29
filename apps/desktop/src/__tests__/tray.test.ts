// The tray icon with an explicit Quit, and "keep running when the window is closed" for dictation and the voice relay
// (D-2), kept in the shell's own settings file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHELL_DEFAULTS, readShellSettings, shellPatch, shellSettingsFile, writeShellSettings } from '../shell-settings'
import { closeAction, shortcutLabel, trayMenu } from '../tray'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ps-shell-'))

describe('the tray (D-2)', () => {
  it('has Open, Dictate, the keep-running choice, Settings and an explicit Quit', () => {
    const items = trayMenu({ windowShown: false, keepRunning: true, dictation: { enabled: true, shortcut: 'CommandOrControl+Alt+D' } }, 'win32')
    expect(items.filter((i) => i.id !== 'sep').map((i) => 'label' in i && i.label)).toEqual([
      'Open Producer Studio',
      'Dictate (Ctrl+Alt+D)',
      'Keep running when the window is closed',
      'Settings…',
      'Quit Producer Studio',
    ])
    expect(items.find((i) => i.id === 'keep')).toMatchObject({ type: 'checkbox', checked: true })
    expect(items.at(-1)).toMatchObject({ id: 'quit' })
  })

  it('Dictate is off, and says where to turn it on, while the shortcut is off; the shortcut reads per platform', () => {
    const off = trayMenu({ windowShown: true, keepRunning: false, dictation: { enabled: false, shortcut: '' } })
    expect(off.find((i) => i.id === 'dictate')).toMatchObject({ enabled: false, label: expect.stringMatching(/Settings → Dictation/) })
    expect(off[0]).toMatchObject({ label: 'Show Producer Studio' })
    expect(shortcutLabel('CommandOrControl+Shift+Space', 'darwin')).toBe('Cmd+Shift+Space')
    expect(shortcutLabel('Control+Alt+D', 'linux')).toBe('Ctrl+Alt+D')
  })

  it('closing the window hides it only when keep running is on and there is a tray; quitting always quits', () => {
    expect(closeAction({ keepRunning: true, quitting: false, hasTray: true })).toBe('hide')
    expect(closeAction({ keepRunning: false, quitting: false, hasTray: true })).toBe('quit')
    expect(closeAction({ keepRunning: true, quitting: true, hasTray: true })).toBe('quit')
    // a desktop without a tray (some Linux) can't get the window back: closing quits
    expect(closeAction({ keepRunning: true, quitting: false, hasTray: false })).toBe('quit')
  })
})

describe('the shell settings file', () => {
  it('starts from the defaults (keep running off, updates on, crash reports off) and keeps what is written', () => {
    const file = shellSettingsFile(tmp())
    expect(readShellSettings(file)).toEqual(SHELL_DEFAULTS)
    expect(SHELL_DEFAULTS).toEqual({ keepRunning: false, updateCheck: true, crashReports: false })
    writeShellSettings(file, { keepRunning: true })
    writeShellSettings(file, { lastStart: { version: '0.7.0', schema: 16 } })
    expect(readShellSettings(file)).toMatchObject({ keepRunning: true, lastStart: { version: '0.7.0', schema: 16 } })
    writeShellSettings(file, { lastStart: undefined })
    expect(readShellSettings(file).lastStart).toBeUndefined()
  })

  it('a damaged or hand-edited file falls back to defaults key by key', () => {
    const file = shellSettingsFile(tmp())
    fs.writeFileSync(file, '{ not json')
    expect(readShellSettings(file)).toEqual(SHELL_DEFAULTS)
    fs.writeFileSync(file, JSON.stringify({ keepRunning: 'yes', crashReports: true, lastStart: { version: 3 } }))
    expect(readShellSettings(file)).toEqual({ ...SHELL_DEFAULTS, crashReports: true })
  })

  it('takes only known on/off settings from the app’s pages', () => {
    expect(shellPatch({ keepRunning: true })).toEqual({ keepRunning: true })
    expect(shellPatch({ updateCheck: false, crashReports: true })).toEqual({ updateCheck: false, crashReports: true })
    for (const bad of [null, [], 'x', {}, { keepRunning: 'true' }, { lastStart: { version: '9' } }, { keepRunning: true, skippedVersion: '1.0.0' }]) expect(shellPatch(bad)).toBeNull()
  })
})
