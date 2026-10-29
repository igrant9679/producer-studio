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

export type Platform = 'win32' | 'linux' | 'darwin' | NodeJS.Platform

export interface AzureSignOptions {
  publisherName: string
  endpoint: string
  codeSigningAccountName: string
  certificateProfileName: string
}

export interface ReleaseConfig {
  /** Merged over electron-builder.yml. */
  config: {
    electronFuses: Fuses
    win?: { azureSignOptions?: AzureSignOptions; forceCodeSigning?: boolean }
    mac?: { notarize: boolean }
  }
  signed: boolean
  notes: string[]
  targets: string[]
}

export const AZURE_SIGNING: string[]
export const AZURE_AUTH: string[]
export function windowsSigning(env?: Record<string, string | undefined>): { mode: 'azure' | 'certificate' | 'none'; azureSignOptions?: AzureSignOptions; missing?: string[] }
export function platformOf(args: string[], host: Platform): Platform
export function targetsFor(platform: Platform, dir?: boolean): string[]
export function releaseConfig(o?: { env?: Record<string, string | undefined>; platform?: Platform }): ReleaseConfig
export function keepStagedPath(rel: string, platform?: Platform, arch?: string): boolean
export function chromeLayout(platform?: Platform, arch?: string): { cachePrefix: string; folder: string; exe: string }
export function schemaVersionOf(migrateSource: string): number | undefined
export function updateRepoOf(raw: unknown): string | undefined
export function buildInfo(o: { version: string; migrateSource: string; env?: Record<string, string | undefined>; now?: number }): BuildInfo
