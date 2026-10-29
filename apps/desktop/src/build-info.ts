// dist/build-info.json, written by scripts/build.mjs: what this build is (schema version for backups before a
// migration, signed or not, the update feed). A dev build or a missing file reads as unsigned with nothing known.
// No Electron here, so it can be tested on its own.
import fs from 'node:fs'
import path from 'node:path'
import { type BuildInfo, updateRepoOf } from '../scripts/release.mjs'

export type { BuildInfo }

export function parseBuildInfo(raw: unknown, fallbackVersion: string): BuildInfo {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const info: BuildInfo = {
    version: typeof o.version === 'string' ? o.version : fallbackVersion,
    builtAt: typeof o.builtAt === 'string' ? o.builtAt : '',
    signed: o.signed === true,
  }
  if (Number.isInteger(o.schemaVersion) && (o.schemaVersion as number) > 0) info.schemaVersion = o.schemaVersion as number
  const repo = updateRepoOf(o.updateRepo)
  if (repo) info.updateRepo = repo
  return info
}

/** build-info.json next to the built main process (dist/), or the fallback. */
export function readBuildInfo(dir: string, fallbackVersion: string): BuildInfo {
  try {
    return parseBuildInfo(JSON.parse(fs.readFileSync(path.join(dir, 'build-info.json'), 'utf8')), fallbackVersion)
  } catch {
    return parseBuildInfo(undefined, fallbackVersion)
  }
}
