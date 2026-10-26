// Desktop hardening that doesn't need a running desktop server: the launch secrets stay out of child processes, the
// VoiceStudio import only fetches output paths, and the cloud URL must be https (plain http on loopback only).
import { afterAll, describe, expect, it } from 'vitest'
import { childEnv, desktopSecret, takeDesktopSecrets } from '../child-env'
import { normalizeCloudUrl } from '../desktop/cloud'
import { secretMatches } from '../desktop/identity'
import { seal, unseal } from '../desktop/secrets'
import { isImportSource } from '../desktop/voicestudio/routes'
import { run } from '../media/proc'

describe('desktop launch secrets', () => {
  const prev = { ...process.env }
  afterAll(() => {
    process.env = prev
  })

  it('move from process.env into memory and still open sessions and unseal keys', () => {
    process.env.DESKTOP_SECRET = 'launch-secret-0123456789'
    process.env.DESKTOP_SECRET_KEY = Buffer.alloc(32, 7).toString('base64')
    takeDesktopSecrets()
    expect(process.env.DESKTOP_SECRET).toBeUndefined()
    expect(process.env.DESKTOP_SECRET_KEY).toBeUndefined()
    expect(desktopSecret('DESKTOP_SECRET')).toBe('launch-secret-0123456789')
    expect(secretMatches('launch-secret-0123456789')).toBe(true)
    expect(secretMatches('launch-secret-0123456780')).toBe(false)
    const sealed = seal('device-token')
    expect(sealed.protection).toBe('os')
    expect(unseal(sealed)).toBe('device-token')
  })

  it('are stripped from every child environment, even one built from a copy that still has them', async () => {
    expect(childEnv({ PATH: 'p', DESKTOP_SECRET: 's', DESKTOP_SECRET_KEY: 'k' }, { EXTRA: '1' })).toEqual({ PATH: 'p', EXTRA: '1' })
    const probe = 'process.stdout.write(JSON.stringify([process.env.DESKTOP_SECRET ?? null, process.env.DESKTOP_SECRET_KEY ?? null]))'
    const r = await run(process.execPath, ['-e', probe], { env: { ...process.env, DESKTOP_SECRET: 'leak', DESKTOP_SECRET_KEY: 'leak' } })
    expect(JSON.parse(r.stdout)).toEqual([null, null])
    const inherited = await run(process.execPath, ['-e', probe])
    expect(JSON.parse(inherited.stdout)).toEqual([null, null])
  })
})

describe('VoiceStudio import sources', () => {
  it('accepts the output paths the Voice Studio pages send', () => {
    for (const s of [
      '/audio/h2.wav',
      '/audio/longform%2Fstory%20one.m4b',
      '/audio/books/chapter%201.mp3',
      '/batch/download/b1a2/es',
      '/dub/download/j1?default_track=es&include_tracks=es&preserve_bg=true',
      '/dub/download/j1?out_format=m4a',
      '/dub/download-audio/j1?lang=pt-BR&preserve_bg=true',
      '/audiobook/x',
      '/voice_audio/p1.wav',
    ])
      expect(isImportSource(s), s).toBe(true)
  })

  it('refuses anything that would reach another VoiceStudio route once fetch() normalises it', () => {
    for (const s of [
      '/system/info',
      '/audio/../system/info',
      '/audio/./../system/info',
      '/audio/%2e%2e/system/info',
      '/audio/.%2E/system/shutdown-intent',
      '/audio/%2E./profiles',
      '/audio\\..\\system\\info',
      '/audio/x/..',
      '/audio#/../../system/info',
      '/audio/x\n/../../system',
      '/audio/\t../system/info',
      '//evil.example/audio/x.wav',
      '/audiox/1.wav',
      '/profiles/p1/audio',
      'audio/x.wav',
    ])
      expect(isImportSource(s), JSON.stringify(s)).toBe(false)
  })
})

describe('cloud URL', () => {
  it('must be https, except for a cloud on this computer', () => {
    expect(normalizeCloudUrl(' https://producerstudio.app/ ')).toBe('https://producerstudio.app')
    expect(normalizeCloudUrl('https://cloud.example.com/base//')).toBe('https://cloud.example.com/base')
    expect(normalizeCloudUrl('http://127.0.0.1:4100/')).toBe('http://127.0.0.1:4100')
    expect(normalizeCloudUrl('http://localhost:4100')).toBe('http://localhost:4100')
    expect(normalizeCloudUrl('http://[::1]:4100')).toBe('http://[::1]:4100')
    for (const bad of ['http://producerstudio.app', 'http://192.168.1.20:4100', 'http://localhost.example.com', 'ftp://producerstudio.app', 'producerstudio.app', 'not a url'])
      expect(() => normalizeCloudUrl(bad), bad).toThrow(/https:\/\//)
  })
})
