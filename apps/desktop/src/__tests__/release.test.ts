// What a build records about itself (build-info.json) and how the desktop build is configured (D-3, D-12, D-17).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FUSES, buildInfo, chromeLayout, keepStagedPath, platformOf, releaseConfig, schemaVersionOf, targetsFor, updateRepoOf, windowsSigning } from '../../scripts/release.mjs'
import { parseBuildInfo } from '../build-info'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrate = fs.readFileSync(path.resolve(here, '..', '..', '..', 'server', 'src', 'db', 'migrate.ts'), 'utf8')

describe('Electron fuses (D-12)', () => {
  it('turn off the Node-mode switches, load only the checked app.asar, and keep runAsNode for the engine’s children', () => {
    const { config } = releaseConfig()
    expect(config.electronFuses).toEqual({
      runAsNode: true,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    })
    // a copy: a build can't change the constant
    config.electronFuses.runAsNode = false
    expect(FUSES.runAsNode).toBe(true)
  })

  it('the engine’s Node children that need runAsNode are still started with the app binary', () => {
    // if these stop using process.execPath, runAsNode can be switched off too
    const server = path.resolve(here, '..', '..', '..', 'server', 'src')
    expect(fs.readFileSync(path.join(server, 'ai', 'tts.ts'), 'utf8')).toMatch(/spawn\(process\.execPath/)
    expect(fs.readFileSync(path.join(server, 'ai', 'cli.ts'), 'utf8')).toMatch(/command: process\.execPath/)
  })

  it('the app makes no use of NODE_OPTIONS or --inspect that the fuses would break', () => {
    const src = path.resolve(here, '..')
    const code = (f: string) =>
      fs
        .readFileSync(path.join(src, f), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
        .join('\n')
    for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.ts'))) expect(code(f), f).not.toMatch(/NODE_OPTIONS|--inspect/)
  })
})

describe('code signing from the environment (D-3)', () => {
  const azure = {
    AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
    AZURE_TRUSTED_SIGNING_ACCOUNT: 'producer',
    AZURE_TRUSTED_SIGNING_PROFILE: 'public-trust',
    AZURE_TENANT_ID: 't',
    AZURE_CLIENT_ID: 'c',
    AZURE_CLIENT_SECRET: 's',
  }

  it('with nothing set the build is unsigned, exactly as before, and says so', () => {
    const r = releaseConfig({ env: {}, platform: 'win32' })
    expect(r.signed).toBe(false)
    expect(r.config).toEqual({ electronFuses: FUSES })
    expect(r.notes.join(' ')).toMatch(/unsigned/)
    expect(r.targets).toEqual(['nsis'])
  })

  it('Azure Trusted Signing, when its account and credentials are set, signs and fails the build rather than ship unsigned', () => {
    const r = releaseConfig({ env: azure, platform: 'win32' })
    expect(r.signed).toBe(true)
    expect(r.config.win).toEqual({
      azureSignOptions: { publisherName: 'Producer Studio', endpoint: 'https://weu.codesigning.azure.net', codeSigningAccountName: 'producer', certificateProfileName: 'public-trust' },
      forceCodeSigning: true,
    })
    expect(releaseConfig({ env: { ...azure, AZURE_TRUSTED_SIGNING_PUBLISHER: 'Producer Studio Ltd' }, platform: 'win32' }).config.win?.azureSignOptions?.publisherName).toBe('Producer Studio Ltd')
    // the secrets themselves never go into the config (the signing module reads them from the environment)
    expect(JSON.stringify(r.config)).not.toContain('"s"')
  })

  it('half an Azure setup stops the build and names what is missing', () => {
    const { AZURE_CLIENT_SECRET: _drop, ...partial } = azure
    void _drop
    expect(windowsSigning(partial)).toMatchObject({ mode: 'none', missing: ['AZURE_CLIENT_SECRET'] })
    expect(() => releaseConfig({ env: partial, platform: 'win32' })).toThrow(/only partly set up: AZURE_CLIENT_SECRET is missing/)
  })

  it('a .pfx certificate (CSC_LINK) signs as electron-builder always did, now required to succeed', () => {
    expect(windowsSigning({ CSC_LINK: 'cert.pfx' })).toEqual({ mode: 'certificate' })
    expect(releaseConfig({ env: { WIN_CSC_LINK: 'x' }, platform: 'win32' })).toMatchObject({ signed: true, config: { win: { forceCodeSigning: true } } })
  })
})

describe('Linux build, macOS prepared (D-17)', () => {
  it('builds for the platform asked, else this machine’s, with its installers', () => {
    expect(platformOf(['--linux'], 'win32')).toBe('linux')
    expect(platformOf(['--mac', '--dir'], 'linux')).toBe('darwin')
    expect(platformOf([], 'linux')).toBe('linux')
    expect(targetsFor('linux')).toEqual(['AppImage', 'deb'])
    expect(targetsFor('darwin')).toEqual(['dmg', 'zip'])
    expect(targetsFor('win32')).toEqual(['nsis'])
    expect(targetsFor('linux', true)).toEqual(['dir'])
  })

  it('Linux packages carry the fuses and aren’t signed; Windows signing settings don’t apply there', () => {
    const r = releaseConfig({ env: { CSC_LINK: 'x.pfx' }, platform: 'linux' })
    expect(r).toMatchObject({ signed: false, targets: ['AppImage', 'deb'], config: { electronFuses: FUSES } })
    expect(r.config.win).toBeUndefined()
  })

  it('macOS is notarised only with a signing identity and an Apple account; otherwise it says what it is', () => {
    const none = releaseConfig({ env: {}, platform: 'darwin' })
    expect(none).toMatchObject({ signed: false, config: { mac: { notarize: false } } })
    expect(none.notes[0]).toMatch(/not notarised/)
    expect(releaseConfig({ env: { CSC_NAME: 'Developer ID Application: Producer' }, platform: 'darwin' }).config.mac).toEqual({ notarize: false })
    const full = releaseConfig({ env: { CSC_LINK: 'id.p12', APPLE_API_KEY: 'k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I' }, platform: 'darwin' })
    expect(full).toMatchObject({ signed: true, config: { mac: { notarize: true } } })
  })

  it('the staged server keeps only this platform’s native binaries', () => {
    expect(keepStagedPath('onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1', 'linux')).toBe(true)
    expect(keepStagedPath('onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll', 'linux')).toBe(false)
    expect(keepStagedPath('onnxruntime-node\\bin\\napi-v6\\darwin\\arm64\\x.node', 'win32')).toBe(false)
    expect(keepStagedPath('ffprobe-static/bin/linux/x64/ffprobe', 'linux', 'x64')).toBe(true)
    expect(keepStagedPath('ffprobe-static/bin/linux/ia32/ffprobe', 'linux', 'x64')).toBe(false)
    expect(keepStagedPath('ffprobe-static/bin/win32/x64/ffprobe.exe', 'win32', 'x64')).toBe(true)
    expect(keepStagedPath('ffprobe-static/bin/darwin/x64/ffprobe', 'win32', 'x64')).toBe(false)
    // as before: no wasm sharp, no tests, maps or readmes
    for (const p of ['@img/sharp-wasm32/lib/x.wasm', 'pkg/__tests__/a.js', 'pkg/dist/a.js.map', 'pkg/README.md', 'pkg/index.d.ts']) expect(keepStagedPath(p, 'linux')).toBe(false)
    expect(keepStagedPath('pkg/dist/index.js', 'linux')).toBe(true)
  })

  it('finds chrome-headless-shell in the browser cache for each platform', () => {
    expect(chromeLayout('win32')).toEqual({ cachePrefix: 'win64-', folder: 'chrome-headless-shell-win64', exe: 'chrome-headless-shell.exe' })
    expect(chromeLayout('linux')).toMatchObject({ folder: 'chrome-headless-shell-linux64', exe: 'chrome-headless-shell' })
    expect(chromeLayout('darwin', 'arm64')).toMatchObject({ cachePrefix: 'mac_arm-', folder: 'chrome-headless-shell-mac-arm64' })
  })

  it('electron-builder.yml has the Linux and macOS sections, and the entitlements file exists', () => {
    const yml = fs.readFileSync(path.resolve(here, '..', '..', 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')
    expect(yml).toMatch(/^linux:\n {2}target: \[AppImage, deb\]/m)
    expect(yml).toMatch(/^deb:\n.*\n {2}recommends: \[xdotool, wtype/m)
    expect(yml).toMatch(/^mac:\n {2}target: \[dmg, zip\]/m)
    const ent = /entitlements: (\S+)/.exec(yml)![1]
    expect(fs.readFileSync(path.resolve(here, '..', '..', ent), 'utf8')).toContain('com.apple.security.device.audio-input')
  })
})

describe('build-info.json (D-10, D-4)', () => {
  it('records the schema the engine migrates to, read from the server’s migrations', () => {
    const v = schemaVersionOf(migrate)
    expect(Number.isInteger(v)).toBe(true)
    expect(v).toBeGreaterThanOrEqual(15)
    expect(schemaVersionOf('nothing here')).toBeUndefined()
  })

  it('is unsigned with no update feed unless the build says otherwise', () => {
    const info = buildInfo({ version: '0.7.0', migrateSource: 'export const SCHEMA_VERSION = 16', now: 0 })
    expect(info).toEqual({ version: '0.7.0', builtAt: '1970-01-01T00:00:00.000Z', signed: false, schemaVersion: 16 })
    const signed = buildInfo({ version: '0.7.0', migrateSource: '', env: { PS_BUILD_SIGNED: '1', PS_UPDATE_REPO: 'producer-studio/desktop' } })
    expect(signed).toMatchObject({ signed: true, updateRepo: 'producer-studio/desktop' })
    expect(signed.schemaVersion).toBeUndefined()
    for (const bad of ['', 'https://github.com/a/b', 'a/b/c', 'a b/c', '../x']) expect(updateRepoOf(bad)).toBeUndefined()
  })

  it('the app reads it back defensively; a dev build without one is unsigned with nothing known', () => {
    expect(parseBuildInfo(undefined, '0.6.1')).toEqual({ version: '0.6.1', builtAt: '', signed: false })
    expect(parseBuildInfo({ version: '0.7.0', signed: 'yes', schemaVersion: 1.5, updateRepo: 'not a repo' }, 'x')).toEqual({ version: '0.7.0', builtAt: '', signed: false })
    expect(parseBuildInfo({ version: '0.7.0', builtAt: 'b', signed: true, schemaVersion: 16, updateRepo: 'o/r' }, 'x')).toEqual({ version: '0.7.0', builtAt: 'b', signed: true, schemaVersion: 16, updateRepo: 'o/r' })
  })
})
