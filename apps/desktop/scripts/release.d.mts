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

/** electron-builder's electronFuses (FuseOptionsV1). */
export interface Fuses {
  runAsNode: boolean
  enableCookieEncryption: boolean
  enableNodeOptionsEnvironmentVariable: boolean
  enableNodeCliInspectArguments: boolean
  enableEmbeddedAsarIntegrityValidation: boolean
  onlyLoadAppFromAsar: boolean
  grantFileProtocolExtraPrivileges: boolean
}

export const FUSES: Fuses

export interface ReleaseConfig {
  /** Merged over electron-builder.yml. */
  config: { electronFuses: Fuses } & Record<string, unknown>
}

export function releaseConfig(): ReleaseConfig
export function schemaVersionOf(migrateSource: string): number | undefined
export function updateRepoOf(raw: unknown): string | undefined
export function buildInfo(o: { version: string; migrateSource: string; env?: Record<string, string | undefined>; now?: number }): BuildInfo
