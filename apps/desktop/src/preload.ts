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
