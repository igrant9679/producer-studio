// How dictation pastes into the focused app on each platform (D-17): Windows sends Ctrl+V through SendKeys, Linux uses
// wtype on Wayland or xdotool on X11 (whichever is installed), macOS asks System Events for Cmd+V (the app needs the
// Accessibility permission). Without one, the text is left on the clipboard for the person to paste. No Electron here.
import fs from 'node:fs'
import path from 'node:path'

export interface PasteCommand {
  cmd: string
  args: string[]
  /** For the log and docs: what pastes. */
  via: string
}

export interface PasteEnv {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Whether a program is on PATH. */
  has: (cmd: string) => boolean
}

/** A program on PATH (an executable file in one of its folders). */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = isExecutable): boolean {
  return (env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => exists(path.join(dir, cmd)))
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

export function pasteCommand(e: PasteEnv): PasteCommand | null {
  if (e.platform === 'win32')
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"], via: 'SendKeys' }
  if (e.platform === 'darwin') return { cmd: 'osascript', args: ['-e', 'tell application "System Events" to keystroke "v" using command down'], via: 'System Events' }
  if (e.platform !== 'linux') return null
  const wayland = !!e.env.WAYLAND_DISPLAY || e.env.XDG_SESSION_TYPE === 'wayland'
  // wtype types into Wayland apps; xdotool into X11 ones (and, on Wayland, into apps running under XWayland)
  if (wayland && e.has('wtype')) return { cmd: 'wtype', args: ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'], via: 'wtype' }
  if (e.env.DISPLAY && e.has('xdotool')) return { cmd: 'xdotool', args: ['key', '--clearmodifiers', 'ctrl+v'], via: 'xdotool' }
  return null
}

/** Said in the log when dictation can't paste on this computer. */
export function noPasteReason(platform: NodeJS.Platform): string {
  return platform === 'linux'
    ? 'install wtype (Wayland) or xdotool (X11) to paste automatically; until then the text is copied to the clipboard'
    : 'automatic paste isn’t available on this platform; the text is copied to the clipboard'
}
