// The tray icon (D-2): an explicit way to quit, and the choice to keep Producer Studio running when its window is
// closed, for the system-wide dictation shortcut and the voice relay (the cloud asking this computer for a voice made
// here). Without that choice, closing the window quits, as before. No Electron here, so it can be tested on its own.

export interface TrayState {
  /** The main window is on screen (not closed into the tray). */
  windowShown: boolean
  keepRunning: boolean
  dictation: { enabled: boolean; shortcut: string }
}

export type TrayItem =
  | { id: 'open' | 'dictate' | 'settings' | 'quit'; label: string; enabled?: boolean; accelerator?: string }
  | { id: 'keep'; label: string; type: 'checkbox'; checked: boolean }
  | { id: 'sep'; type: 'separator' }

/** "CommandOrControl+Alt+D" as people read it on this platform. */
export function shortcutLabel(accel: string, platform: NodeJS.Platform): string {
  return accel
    .split('+')
    .map((p) => (/^(CommandOrControl|CmdOrCtrl)$/.test(p) ? (platform === 'darwin' ? 'Cmd' : 'Ctrl') : p === 'Control' ? 'Ctrl' : p))
    .join('+')
}

export function trayMenu(s: TrayState, platform: NodeJS.Platform = process.platform): TrayItem[] {
  return [
    { id: 'open', label: s.windowShown ? 'Show Producer Studio' : 'Open Producer Studio' },
    {
      id: 'dictate',
      label: s.dictation.enabled && s.dictation.shortcut ? `Dictate (${shortcutLabel(s.dictation.shortcut, platform)})` : 'Dictate (turn it on in Settings → Dictation)',
      enabled: s.dictation.enabled,
    },
    { id: 'sep', type: 'separator' },
    { id: 'keep', label: 'Keep running when the window is closed', type: 'checkbox', checked: s.keepRunning },
    { id: 'settings', label: 'Settings…' },
    { id: 'sep', type: 'separator' },
    { id: 'quit', label: 'Quit Producer Studio' },
  ]
}

/** What closing the main window does: hide it into the tray (keep running) or quit the app. Quitting always quits. */
export function closeAction(o: { keepRunning: boolean; quitting: boolean; hasTray: boolean }): 'hide' | 'quit' {
  return o.keepRunning && !o.quitting && o.hasTray ? 'hide' : 'quit'
}

export const TRAY_HINT = 'Producer Studio is still running, so the dictation shortcut and your voices for the cloud keep working. Quit it from this icon.'
