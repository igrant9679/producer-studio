// Desktop settings (DesktopSettings in core/api.ts), persisted as JSON. The Electron main process passes
// DESKTOP_SETTINGS_FILE (outside the data folder, so a moved data folder can still be found at the next launch);
// otherwise the file lives in DATA_DIR.
import fs from 'node:fs'
import path from 'node:path'
import * as z from 'zod/v4'
import type { DesktopSettings } from '@producer/core'
import { ctx } from '../context'
import { log } from '../log'

const Schema = z.object({
  claudePath: z.string().max(1000),
  claudeModel: z.string().max(100),
  dataDir: z.string().max(1000),
  mediaSync: z.enum(['all', 'on-demand']),
  autoSync: z.boolean(),
})

export const SettingsPatch = Schema.partial().strict()

let cache: DesktopSettings | undefined
const listeners = new Set<(s: DesktopSettings, prev: DesktopSettings) => void>()

export function settingsFile(): string {
  return process.env.DESKTOP_SETTINGS_FILE || path.join(ctx().config.dataDir, 'settings.json')
}

function defaults(): DesktopSettings {
  return { claudePath: '', claudeModel: '', dataDir: ctx().config.dataDir, mediaSync: 'on-demand', autoSync: true }
}

export function getSettings(): DesktopSettings {
  if (cache) return cache
  const base = defaults()
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>
    const r = Schema.partial().safeParse(raw)
    cache = { ...base, ...(r.success ? r.data : {}) }
  } catch {
    cache = base
  }
  return cache
}

export function saveSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const prev = getSettings()
  const next: DesktopSettings = { ...prev, ...patch }
  if (patch.dataDir !== undefined) {
    const d = patch.dataDir.trim()
    if (!d || !path.isAbsolute(d)) throw Object.assign(new Error('The data folder must be an absolute path'), { invalid: true })
    next.dataDir = path.resolve(d)
  }
  if (patch.claudePath !== undefined) next.claudePath = patch.claudePath.trim().replace(/^"(.*)"$/, '$1')
  const file = settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file)
  cache = next
  for (const l of listeners) {
    try {
      l(next, prev)
    } catch (err) {
      log.warn('settings listener failed', { err })
    }
  }
  return next
}

export function onSettingsChange(fn: (s: DesktopSettings, prev: DesktopSettings) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Test hook. */
export function resetSettingsCache() {
  cache = undefined
}
