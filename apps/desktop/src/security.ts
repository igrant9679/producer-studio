// Renderer hardening: navigation locked to the local server origin, window.open routed safely, permission requests
// denied except the few the editor needs, and IPC argument validation helpers.
import fs from 'node:fs'
import path from 'node:path'
import { type BrowserWindowConstructorOptions, type Session, type WebContents, shell } from 'electron'

let localOrigin = ''

export function setLocalOrigin(origin: string) {
  localOrigin = origin
}

export function isLocal(url: string): boolean {
  try {
    return !!localOrigin && new URL(url).origin === localOrigin
  } catch {
    return false
  }
}

/** http(s) URLs only, reasonable length, no credentials in the URL. */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  return u.toString()
}

export function openExternal(raw: unknown): boolean {
  const url = safeExternalUrl(raw)
  if (!url || isLocal(url)) return false
  void shell.openExternal(url)
  return true
}

export type NativeThemeMode = 'system' | 'dark' | 'light'

/** Validate a theme mode from the renderer; null for anything else. */
export function nativeThemeMode(raw: unknown): NativeThemeMode | null {
  return raw === 'system' || raw === 'dark' || raw === 'light' ? raw : null
}

/** A path inside the data folder (after resolving symlinks), or null. */
export function insideDataDir(raw: unknown, dataDir: string): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || raw.includes('\0')) return null
  let target: string
  let root: string
  try {
    root = fs.realpathSync(dataDir)
    target = fs.realpathSync(path.resolve(raw))
  } catch {
    return null
  }
  const rel = path.relative(root, target)
  if (rel === '') return target
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return target
}

export const SECURE_PREFS = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
} as const

/** Media/share pages opened from the app (e.g. an export's "Open") get a plain sandboxed viewer window. */
function viewerWindow(): BrowserWindowConstructorOptions {
  return { width: 1100, height: 700, autoHideMenuBar: true, backgroundColor: '#0c0e14', webPreferences: { ...SECURE_PREFS } }
}

export function hardenContents(wc: WebContents) {
  wc.on('will-navigate', (e, url) => {
    if (isLocal(url)) return
    e.preventDefault()
    openExternal(url)
  })
  wc.on('will-redirect', (e, url) => {
    if (!isLocal(url)) e.preventDefault()
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())
  wc.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) {
      const p = new URL(url).pathname
      if (p.startsWith('/api/media/') || p.startsWith('/api/share/') || p.startsWith('/r/')) return { action: 'allow', overrideBrowserWindowOptions: viewerWindow() }
      return { action: 'deny' }
    }
    openExternal(url)
    return { action: 'deny' }
  })
}

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

export function hardenSession(s: Session) {
  s.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission) && isLocal(wc.getURL())))
  s.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && isLocal(origin))
  s.setDevicePermissionHandler(() => false)
  // downloads (export "Download", asset originals) always ask where to save
  s.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Save', defaultPath: item.getFilename() })
  })
}
