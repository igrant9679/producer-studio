// System-wide dictation: a global shortcut opens a small always-on-top widget (never focused, so the app the user is
// typing in keeps the caret) that streams the microphone to VoiceStudio and shows live text. Pressing the shortcut again
// stops; the final text is put on the clipboard and pasted into the focused app with Ctrl+V, then the person's
// clipboard (every format kept) is put back once the paste has happened. The widget is our own local page (/dictate);
// IPC is accepted only from local pages.
import { spawn } from 'node:child_process'
import { BrowserWindow, ClipboardItem, clipboard, globalShortcut, ipcMain, screen } from 'electron'
import { type ClipboardLike, pasteKeepingClipboard } from './clipboard'

const systemClipboard: ClipboardLike<ClipboardItem> = {
  read: () => clipboard.read(),
  write: (items) => clipboard.write(items),
  readText: () => clipboard.readText(),
  writeText: (text) => clipboard.writeText(text),
  clear: () => clipboard.clear(),
  item: (data) => new ClipboardItem(data as ConstructorParameters<typeof ClipboardItem>[0]),
}

export interface DictationDeps {
  origin: () => string | undefined
  isLocal: (url: string) => boolean
  preload: string
  secure: Electron.WebPreferences
  log: (msg: string) => void
}

interface Config {
  enabled: boolean
  shortcut: string
  paste: boolean
}

const WIDTH = 520
const HEIGHT = 112

/** Electron accelerator sanity check (modifiers + one key, no exotic tokens). */
export function validAccelerator(s: string): boolean {
  if (!s || s.length > 60) return false
  const parts = s.split('+')
  const mods = new Set(['CommandOrControl', 'CmdOrCtrl', 'Control', 'Ctrl', 'Alt', 'Shift', 'Super', 'Meta', 'Option', 'AltGr'])
  const key = parts.pop()!
  if (!parts.length || !parts.every((p) => mods.has(p))) return false
  return /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Escape|Esc|Plus|[`\-=[\];',./\\])$/.test(key)
}

export function setupDictation(d: DictationDeps) {
  let cfg: Config = { enabled: false, shortcut: '', paste: true }
  let registered = ''
  let widget: BrowserWindow | undefined
  let open = false

  const fromLocal = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => d.isLocal(e.senderFrame?.url ?? '')

  function ensureWidget(): BrowserWindow | undefined {
    const origin = d.origin()
    if (!origin) return undefined
    if (widget && !widget.isDestroyed()) return widget
    widget = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      title: 'Producer Studio dictation',
      webPreferences: { ...d.secure, preload: d.preload, backgroundThrottling: false },
    })
    widget.setAlwaysOnTop(true, 'floating')
    widget.setVisibleOnAllWorkspaces(true)
    widget.on('closed', () => {
      widget = undefined
      open = false
    })
    void widget.loadURL(`${origin}/dictate`)
    return widget
  }

  function place(w: BrowserWindow) {
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const { x, y, width, height } = disp.workArea
    w.setBounds({ x: Math.round(x + (width - WIDTH) / 2), y: Math.round(y + height - HEIGHT - 32), width: WIDTH, height: HEIGHT })
  }

  function toggle() {
    const w = ensureWidget()
    if (!w) return
    if (!open) {
      open = true
      place(w)
      const go = () => {
        w.showInactive()
        w.webContents.send('dictation:command', 'start')
      }
      if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go)
      else go()
    } else {
      w.webContents.send('dictation:command', 'stop')
    }
  }

  function hide() {
    open = false
    if (widget && !widget.isDestroyed()) widget.hide()
  }

  /**
   * Paste into the foreground app (the widget never takes focus). Resolves once the keystroke has been sent (the
   * process exited, however long a cold PowerShell takes to start), failed, or after 15 s at most.
   */
  function paste(): Promise<void> {
    if (process.platform !== 'win32') return Promise.resolve()
    return new Promise<void>((resolve) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"], { windowsHide: true, stdio: 'ignore' })
      const t = setTimeout(() => {
        d.log('dictation: paste took more than 15 s')
        resolve()
      }, 15_000)
      const done = () => {
        clearTimeout(t)
        resolve()
      }
      ps.on('exit', done)
      ps.on('error', (err) => {
        d.log(`dictation: paste failed: ${String(err)}`)
        done()
      })
    })
  }

  function apply(next: Config): { ok: boolean; error?: string } {
    cfg = next
    if (registered) {
      globalShortcut.unregister(registered)
      registered = ''
    }
    if (!cfg.enabled) {
      hide()
      return { ok: true }
    }
    if (!validAccelerator(cfg.shortcut)) return { ok: false, error: 'That shortcut isn’t valid. Use modifiers plus one key, e.g. Ctrl+Alt+D.' }
    let ok = false
    try {
      ok = globalShortcut.register(cfg.shortcut, toggle)
    } catch {
      ok = false
    }
    if (!ok) return { ok: false, error: 'Another app is already using that shortcut. Pick a different one.' }
    registered = cfg.shortcut
    d.log(`dictation: global shortcut ${cfg.shortcut}`)
    return { ok: true }
  }

  ipcMain.handle('dictation:configure', (e, raw: unknown) => {
    if (!fromLocal(e)) return { ok: false, error: 'refused' }
    const o = (raw ?? {}) as Partial<Config>
    return apply({ enabled: o.enabled === true, shortcut: typeof o.shortcut === 'string' ? o.shortcut.trim() : '', paste: o.paste !== false })
  })

  ipcMain.handle('dictation:result', async (e, raw: unknown) => {
    if (!fromLocal(e)) return false
    hide()
    const text = typeof raw === 'string' ? raw.trim().slice(0, 20_000) : ''
    if (!text) return true
    // without pasting (turned off, or not on Windows), the text stays on the clipboard for the person to paste
    if (!cfg.paste || process.platform !== 'win32') await clipboard.writeText(text)
    // the person's clipboard (every format of every item) comes back only after the paste has happened
    else void pasteKeepingClipboard(systemClipboard, text, paste).catch((err) => d.log(`dictation: clipboard restore failed: ${String(err)}`))
    return true
  })

  ipcMain.handle('dictation:cancel', (e) => {
    if (!fromLocal(e)) return false
    hide()
    return true
  })

  ipcMain.handle('dictation:toggle', (e) => {
    if (!fromLocal(e)) return false
    toggle()
    return true
  })

  return {
    dispose() {
      globalShortcut.unregisterAll()
      if (widget && !widget.isDestroyed()) widget.destroy()
    },
  }
}
