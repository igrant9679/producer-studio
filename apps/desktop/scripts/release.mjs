// What a desktop build is made with, as plain functions (tested in src/__tests__/release.test.ts):
//   buildInfo()     dist/build-info.json, read by the app at runtime (schema version for backups, signed, update feed)
//   releaseConfig() what dist.mjs lays over electron-builder.yml: Electron fuses (D-12)
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

/** The config dist.mjs passes to electron-builder (merged over electron-builder.yml, which it loads as usual). */
export function releaseConfig() {
  return { config: { electronFuses: { ...FUSES } } }
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
