// Types for release.mjs (the desktop build's plain functions).

export interface BuildInfo {
  version: string
  builtAt: string
  /** The installer and app were signed (code signing configured at build time). */
  signed: boolean
  /** The database schema this build's engine migrates to. */
  schemaVersion?: number
  /** owner/repo whose GitHub Releases announce new versions. */
  updateRepo?: string
}

export function schemaVersionOf(migrateSource: string): number | undefined
export function updateRepoOf(raw: unknown): string | undefined
export function buildInfo(o: { version: string; migrateSource: string; env?: Record<string, string | undefined>; now?: number }): BuildInfo
