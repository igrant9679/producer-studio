// What a desktop build is made with, as plain functions (tested in src/__tests__/release.test.ts):
//   buildInfo()     dist/build-info.json, read by the app at runtime (schema version for backups, signed, update feed)
//   releaseConfig() what dist.mjs lays over electron-builder.yml: Electron fuses (D-12), signing from the
//                   environment (D-3: Azure Trusted Signing or a .pfx; macOS Developer ID + notarisation, D-17)
// Kept free of side effects: build.mjs and dist.mjs do the writing and the running.

/**
 * Electron fuses, flipped in the packaged binary (D-12). The Node-mode switches are off: NODE_OPTIONS and
 * --inspect/SIGUSR1 can't turn the installed app into a Node runtime or a debugger target. The app only loads its
 * own app.asar, checked against the hash embedded at build time (Windows needs Electron 30+, macOS 16+). Cookies are
 * encrypted with the OS key store. runAsNode stays on: the engine (in a utility process) still starts its own Node
 * children with the app binary (the TTS worker, the HyperFrames renderer, the MCP server the Claude CLI talks to); see
 * docs/desktop.md for what moving those would take.
 */
export const FUSES = {
  runAsNode: true,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
}

/** Azure Trusted Signing: the account, read from the environment (D-3). Authentication is Microsoft Entra ID's. */
export const AZURE_SIGNING = ['AZURE_TRUSTED_SIGNING_ENDPOINT', 'AZURE_TRUSTED_SIGNING_ACCOUNT', 'AZURE_TRUSTED_SIGNING_PROFILE']
export const AZURE_AUTH = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']

/**
 * How Windows binaries are signed: 'azure' when the Trusted Signing account and its Entra ID credentials are all set,
 * 'certificate' with a .pfx (CSC_LINK / WIN_CSC_LINK, electron-builder's own), else 'none'. Some but not all of the
 * Azure settings is a mistake worth stopping for (`missing`), never a silent unsigned build.
 */
export function windowsSigning(env = {}) {
  const azure = [...AZURE_SIGNING, ...AZURE_AUTH]
  const set = azure.filter((k) => env[k])
  if (set.length && set.length < azure.length) return { mode: 'none', missing: azure.filter((k) => !env[k]) }
  if (set.length === azure.length)
    return {
      mode: 'azure',
      azureSignOptions: {
        // must match the certificate's subject exactly (Trusted Signing: the validated organisation name)
        publisherName: env.AZURE_TRUSTED_SIGNING_PUBLISHER || 'Producer Studio',
        endpoint: env.AZURE_TRUSTED_SIGNING_ENDPOINT,
        codeSigningAccountName: env.AZURE_TRUSTED_SIGNING_ACCOUNT,
        certificateProfileName: env.AZURE_TRUSTED_SIGNING_PROFILE,
      },
    }
  if (env.CSC_LINK || env.WIN_CSC_LINK) return { mode: 'certificate' }
  return { mode: 'none' }
}

/** Notarising a macOS build needs one of electron-builder's credential sets (an Apple developer account). */
const APPLE_NOTARY = [
  ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
  ['APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE'],
]

/** The platform a build is for: --win, --linux or --mac, else the one it runs on. */
export function platformOf(args, host) {
  if (args.includes('--win')) return 'win32'
  if (args.includes('--linux')) return 'linux'
  if (args.includes('--mac')) return 'darwin'
  return host
}

/** electron-builder targets: the installers per platform, or an unpacked folder (--dir). */
export function targetsFor(platform, dir = false) {
  if (dir) return ['dir']
  if (platform === 'linux') return ['AppImage', 'deb']
  if (platform === 'darwin') return ['dmg', 'zip']
  return ['nsis']
}

/**
 * What dist.mjs lays over electron-builder.yml for one platform: the fuses, and signing from the environment.
 * `signed` goes into build-info.json (the app offers update checks only on signed builds); `notes` are printed.
 * Throws for signing that is half set up.
 */
export function releaseConfig({ env = {}, platform = 'win32' } = {}) {
  const config = { electronFuses: { ...FUSES } }
  const notes = []
  let signed = false
  if (platform === 'win32') {
    const s = windowsSigning(env)
    if (s.missing) throw new Error(`Azure Trusted Signing is only partly set up: ${s.missing.join(', ')} ${s.missing.length > 1 ? 'are' : 'is'} missing. Set all of them, or none for an unsigned build.`)
    if (s.mode === 'azure') {
      // a signing failure fails the build instead of shipping unsigned binaries
      config.win = { azureSignOptions: s.azureSignOptions, forceCodeSigning: true }
      signed = true
      notes.push(`signing with Azure Trusted Signing (${env.AZURE_TRUSTED_SIGNING_ACCOUNT} / ${env.AZURE_TRUSTED_SIGNING_PROFILE})`)
    } else if (s.mode === 'certificate') {
      config.win = { forceCodeSigning: true }
      signed = true
      notes.push('signing with the certificate in CSC_LINK')
    } else notes.push('unsigned: no signing settings in the environment (SmartScreen will warn on first run)')
  } else if (platform === 'darwin') {
    // signed with the Developer ID in CSC_LINK / CSC_NAME (or the keychain); notarised when an Apple account is set
    const identity = !!(env.CSC_LINK || env.CSC_NAME)
    const notarize = identity && APPLE_NOTARY.some((keys) => keys.every((k) => env[k]))
    config.mac = { notarize }
    signed = identity
    notes.push(identity ? (notarize ? 'signed and notarised' : 'signed, not notarised (no Apple notary credentials)') : 'unsigned and not notarised: Gatekeeper will block it on other Macs')
  } else notes.push('Linux packages are not signed')
  return { config, signed, notes, targets: targetsFor(platform) }
}

/** SCHEMA_VERSION from apps/server/src/db/migrate.ts's source, or undefined. */
export function schemaVersionOf(migrateSource) {
  const m = /export const SCHEMA_VERSION\s*=\s*(\d+)/.exec(migrateSource)
  return m ? Number(m[1]) : undefined
}

/** owner/repo of a GitHub repository, or undefined for anything else. */
export function updateRepoOf(raw) {
  const v = String(raw ?? '').trim()
  // GitHub: an owner starts with a letter or digit; a repository is never "." or ".."
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/.exec(v)
  return m && !/^\.+$/.test(m[2]) ? v : undefined
}

/**
 * The facts the app reads at runtime. `signed`: this build is signed (dist.mjs sets PS_BUILD_SIGNED=1 when signing is
 * configured); `updateRepo`: PS_UPDATE_REPO (owner/repo whose GitHub Releases announce new versions).
 */
export function buildInfo({ version, migrateSource, env = {}, now = Date.now() }) {
  const info = { version, builtAt: new Date(now).toISOString(), signed: env.PS_BUILD_SIGNED === '1' }
  const schema = schemaVersionOf(migrateSource)
  if (schema !== undefined) info.schemaVersion = schema
  const repo = updateRepoOf(env.PS_UPDATE_REPO)
  if (repo) info.updateRepo = repo
  return info
}
