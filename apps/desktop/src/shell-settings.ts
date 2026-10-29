// The desktop shell's own settings, in <userData>/shell.json (settings.json belongs to the local engine, which rewrites
// it with its own keys only). What the person can change from Settings → This computer goes through shellPatch(),
// which accepts only known keys with the right types. No Electron here, so it can be tested on its own.
import fs from 'node:fs'
import path from 'node:path'

export interface ShellSettings {
  /** Closing the window leaves Producer Studio running in the tray: the dictation shortcut and the voice relay keep working. */
  keepRunning: boolean
  /** Look for a new version at start and once a day (only offered on signed builds that name a release feed). */
  updateCheck: boolean
  /** Keep crash reports on this computer (never sent anywhere); takes effect at the next start. */
  crashReports: boolean
  /** A version the person chose to skip: not offered again. */
  skippedVersion?: string
  /** The last time the engine started: the app version and its database schema (a backup is made before a newer one). */
  lastStart?: { version: string; schema?: number }
  /** "Still running in the tray" was explained once. */
  trayHintShown?: boolean
}

export const SHELL_DEFAULTS: ShellSettings = { keepRunning: false, updateCheck: true, crashReports: false }

/** The keys Settings may change. */
export type ShellPatch = Partial<Pick<ShellSettings, 'keepRunning' | 'updateCheck' | 'crashReports'>>

export const shellSettingsFile = (userData: string) => path.join(userData, 'shell.json')

export function readShellSettings(file: string): ShellSettings {
  let raw: Record<string, unknown> = {}
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) raw = v as Record<string, unknown>
  } catch {
    /* none yet, or unreadable: defaults */
  }
  const s: ShellSettings = { ...SHELL_DEFAULTS }
  for (const k of ['keepRunning', 'updateCheck', 'crashReports', 'trayHintShown'] as const) if (typeof raw[k] === 'boolean') s[k] = raw[k] as boolean
  if (typeof raw.skippedVersion === 'string' && raw.skippedVersion.length <= 40) s.skippedVersion = raw.skippedVersion
  const ls = raw.lastStart as { version?: unknown; schema?: unknown } | undefined
  if (ls && typeof ls.version === 'string') s.lastStart = { version: ls.version, ...(Number.isInteger(ls.schema) ? { schema: ls.schema as number } : {}) }
  return s
}

/** Change some keys (undefined removes one), keeping the rest; written atomically. */
export function writeShellSettings(file: string, patch: Partial<ShellSettings>): ShellSettings {
  const next: Record<string, unknown> = { ...readShellSettings(file), ...patch }
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file)
  return readShellSettings(file)
}

/** A change from the renderer: known keys with boolean values only, or null for anything else. */
export function shellPatch(raw: unknown): ShellPatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: ShellPatch = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((k === 'keepRunning' || k === 'updateCheck' || k === 'crashReports') && typeof v === 'boolean') out[k] = v
    else return null
  }
  return Object.keys(out).length ? out : null
}
