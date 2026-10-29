// What a build records about itself (build-info.json) and how the desktop build is configured (D-3, D-12, D-17).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FUSES, buildInfo, releaseConfig, schemaVersionOf, updateRepoOf } from '../../scripts/release.mjs'
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
