// Narrow, validated bridge for the renderer (sandboxed preload: only `electron`'s contextBridge/ipcRenderer).
// No generic invoke: each function maps to one IPC channel whose handler re-validates its arguments.
import { contextBridge, ipcRenderer } from 'electron'

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? ''

const api = Object.freeze({
  version: arg('ps-version'),
  platform: process.platform,
  /** Open an http(s) URL in the user's browser. Resolves false when refused. */
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('desktop:open-external', String(url)),
  /** Reveal a file (or open the folder) inside the Producer data folder. Resolves false for any other path. */
  showItemInFolder: (p: string): Promise<boolean> => ipcRenderer.invoke('desktop:show-item', String(p)),
  /**
   * Move the data folder: the app asks where, confirms, stops its engine, copies and checks everything, switches and
   * restarts. Resolves when done (ok false: cancelled or failed, with the reason).
   */
  moveDataFolder: (): Promise<{ ok: boolean; dataDir?: string; error?: string }> => ipcRenderer.invoke('desktop:move-data-folder'),
  /** The desktop app's own settings (Settings → This computer). Resolves null when refused. */
  app: Object.freeze({
    settings: (): Promise<unknown> => ipcRenderer.invoke('desktop:app-settings'),
    /** Change keepRunning / updateCheck / crashReports (booleans only; anything else is refused). */
    setSettings: (patch: Record<string, boolean>): Promise<unknown> => ipcRenderer.invoke('desktop:set-app-settings', { ...patch }),
    /** Ask the release feed now (signed builds); resolves the update state. Nothing is downloaded. */
    checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke('desktop:check-updates'),
    /** Put diagnostics (versions, paths, tool check, log tails; secrets taken out) on the clipboard. */
    copyDiagnostics: (): Promise<unknown> => ipcRenderer.invoke('desktop:copy-diagnostics'),
  }),
  /** Make the native window frame and menus follow the app theme ('system' | 'dark' | 'light'). */
  setNativeTheme: (mode: string): Promise<boolean> => ipcRenderer.invoke('desktop:set-native-theme', String(mode)),
  /** System-wide dictation (global shortcut + floating widget + paste into the focused app). */
  dictation: Object.freeze({
    configure: (cfg: { enabled: boolean; shortcut: string; paste: boolean }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('dictation:configure', { enabled: !!cfg?.enabled, shortcut: String(cfg?.shortcut ?? ''), paste: cfg?.paste !== false }),
    /** Widget: hand back the final text (pasted into the focused app). */
    result: (text: string): Promise<boolean> => ipcRenderer.invoke('dictation:result', String(text ?? '')),
    cancel: (): Promise<boolean> => ipcRenderer.invoke('dictation:cancel'),
    toggle: (): Promise<boolean> => ipcRenderer.invoke('dictation:toggle'),
    /** Widget: 'start' | 'stop' commands from the shortcut. Returns an unsubscribe function. */
    onCommand: (cb: (cmd: string) => void): (() => void) => {
      const h = (_e: unknown, cmd: unknown) => cb(String(cmd))
      ipcRenderer.on('dictation:command', h)
      return () => ipcRenderer.removeListener('dictation:command', h)
    },
  }),
})

contextBridge.exposeInMainWorld('producerDesktop', api)
