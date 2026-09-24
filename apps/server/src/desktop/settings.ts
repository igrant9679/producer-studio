// Desktop settings (DesktopSettings in core/api.ts), persisted as JSON. The Electron main process passes
// DESKTOP_SETTINGS_FILE (outside the data folder, so a moved data folder can still be found at the next launch);
// otherwise the file lives in DATA_DIR.
// The same file also holds the local AI provider settings under `ai` (server-only: never part of GET/PUT
// /api/settings; provider keys inside it are sealed with the OS-keystore-protected key, see secrets.ts).
import fs from 'node:fs'
import path from 'node:path'
import * as z from 'zod/v4'
import type { DesktopSettings } from '@producer/core'
import { ctx } from '../context'
import { log } from '../log'
import type { Sealed } from './secrets'

const Schema = z.object({
  claudePath: z.string().max(1000),
  claudeModel: z.string().max(100),
  dataDir: z.string().max(1000),
  mediaSync: z.enum(['all', 'on-demand']),
  autoSync: z.boolean(),
})

export const SettingsPatch = Schema.partial().strict()

/** Local AI settings: the non-secret document (same shape as a cloud workspace's) plus sealed provider keys. */
export interface DesktopAiStore {
  doc: Record<string, unknown>
  keys: Record<string, Sealed & { last4: string; updatedAt: number }>
}

const SealedSchema = z.object({ v: z.literal(1), iv: z.string(), tag: z.string(), data: z.string(), protection: z.enum(['os', 'file']), last4: z.string(), updatedAt: z.number() })
const AiSchema = z.object({ doc: z.record(z.string(), z.unknown()), keys: z.record(z.string(), SealedSchema) })

let cache: DesktopSettings | undefined
let aiCache: DesktopAiStore | undefined
const listeners = new Set<(s: DesktopSettings, prev: DesktopSettings) => void>()

export function settingsFile(): string {
  return process.env.DESKTOP_SETTINGS_FILE || path.join(ctx().config.dataDir, 'settings.json')
}

function defaults(): DesktopSettings {
  return { claudePath: '', claudeModel: '', dataDir: ctx().config.dataDir, mediaSync: 'on-demand', autoSync: true }
}

function load() {
  const base = defaults()
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>
  } catch {
    /* defaults */
  }
  const r = Schema.partial().safeParse(raw)
  cache = { ...base, ...(r.success ? r.data : {}) }
  const a = AiSchema.safeParse(raw.ai)
  aiCache = a.success ? (a.data as DesktopAiStore) : { doc: {}, keys: {} }
}

function write(settings: DesktopSettings, ai: DesktopAiStore) {
  const file = settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const hasAi = Object.keys(ai.doc).length || Object.keys(ai.keys).length
  fs.writeFileSync(tmp, JSON.stringify(hasAi ? { ...settings, ai } : settings, null, 2))
  fs.renameSync(tmp, file)
}

export function getSettings(): DesktopSettings {
  if (!cache) load()
  return cache!
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
  write(next, getAiStore())
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

export function getAiStore(): DesktopAiStore {
  if (!aiCache) load()
  return aiCache!
}

export function saveAiStore(store: DesktopAiStore) {
  write(getSettings(), store)
  aiCache = store
}

export function onSettingsChange(fn: (s: DesktopSettings, prev: DesktopSettings) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Test hook. */
export function resetSettingsCache() {
  cache = undefined
  aiCache = undefined
}
