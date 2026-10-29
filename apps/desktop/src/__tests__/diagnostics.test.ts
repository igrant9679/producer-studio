// "Copy diagnostics" carries what support needs and nothing secret; crash reports stay local and are opt-in (D-14).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { crashReporterOptions, diagnosticsText, listCrashDumps, redact, tailLog } from '../diagnostics'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ps-diag-'))

describe('diagnostics (D-14)', () => {
  it('take secrets, keys, cookies and emails out of everything', () => {
    const leaky = [
      'linked with psd_AbCdEfGh0123456789xyz',
      'cookie: ps_session=s3cr3t-session-value; Path=/',
      'x-desktop-secret: launch-secret-0123456789',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'anthropic sk-ant-api03-abcdefghijklmnop and openai sk-proj1234567890abcdefgh and gemini AIzaSyA1234567890abcdefghijk',
      'DESKTOP_SECRET_KEY=base64keyvalue== ANTHROPIC_API_KEY=whatever',
      '{"password": "correct-horse", "deviceToken": "abc"}',
      'signed in as sam@example.com',
      `key ${'Zm9vYmFy'.repeat(8)}`,
    ].join('\n')
    const out = redact(leaky)
    for (const secret of ['AbCdEfGh0123456789xyz', 's3cr3t-session-value', 'launch-secret-0123456789', 'eyJhbGciOiJIUzI1NiJ9', 'api03-abcdefghijklmnop', 'proj1234567890abcdefgh', 'SyA1234567890abcdefghijk', 'base64keyvalue', 'whatever', 'correct-horse', '"abc"', 'sam@example.com', 'Zm9vYmFyZm9vYmFy'])
      expect(out).not.toContain(secret)
    expect(out).toContain('psd_[redacted]')
    expect(out).toContain('[email]')
    // ordinary log lines survive
    expect(redact('2026-10-28T09:00:00.000Z server ready at http://127.0.0.1:51234')).toBe('2026-10-28T09:00:00.000Z server ready at http://127.0.0.1:51234')
  })

  it('include versions, paths, settings, tools, crash reports and the last log lines', () => {
    const text = diagnosticsText({
      now: Date.UTC(2026, 9, 28),
      app: { version: '0.7.0', electron: '44.4.5', platform: 'win32', engine: 'utility process', signed: false },
      paths: { userData: 'C:\\Users\\sam\\AppData\\Roaming\\Producer Studio', dataDir: 'D:\\Producer' },
      settings: { keepRunning: true, crashReports: false },
      tools: { ok: false, tools: [{ id: 'whisper', status: 'error', detail: 'The speech model is missing.' }] },
      crashes: [{ name: 'abc.dmp', at: Date.UTC(2026, 9, 27), bytes: 204_800 }],
      logs: [{ name: 'main.log', lines: ['server ready', 'device token psd_secretsecretsecret'] }],
    })
    expect(text).toContain('Producer Studio diagnostics, 2026-10-28T00:00:00.000Z')
    expect(text).toContain('  version: 0.7.0')
    expect(text).toContain('  engine: utility process')
    expect(text).toContain('  dataDir: D:\\Producer')
    expect(text).toContain('  whisper: error · The speech model is missing.')
    expect(text).toContain('Crash reports kept on this computer: 1')
    expect(text).toContain('  abc.dmp · 2026-10-27T00:00:00.000Z · 200 KB')
    expect(text).toContain('Last 2 lines of main.log')
    expect(text).not.toContain('psd_secretsecretsecret')
  })

  it('reads the end of a log, reaching into the rotated one when the current is short', () => {
    const d = tmp()
    const f = path.join(d, 'main.log')
    fs.writeFileSync(`${f}.1`, 'old 1\nold 2\nold 3\n')
    fs.writeFileSync(f, 'new 1\nnew 2\n')
    expect(tailLog(f, 3)).toEqual(['old 3', 'new 1', 'new 2'])
    expect(tailLog(path.join(d, 'missing.log'))).toEqual([])
  })
})

describe('crash reports (D-14)', () => {
  it('are off unless opted in, and never uploaded when on', () => {
    expect(crashReporterOptions(false)).toBeNull()
    expect(crashReporterOptions(true)).toEqual({ uploadToServer: false, submitURL: '', compress: true })
  })

  it('lists the minidumps kept on this computer, newest first', () => {
    const d = tmp()
    fs.mkdirSync(path.join(d, 'reports'), { recursive: true })
    fs.writeFileSync(path.join(d, 'reports', 'a.dmp'), Buffer.alloc(10))
    fs.writeFileSync(path.join(d, 'reports', 'b.dmp'), Buffer.alloc(20))
    fs.writeFileSync(path.join(d, 'settings.dat'), 'x')
    fs.utimesSync(path.join(d, 'reports', 'a.dmp'), new Date(1000), new Date(1000))
    fs.utimesSync(path.join(d, 'reports', 'b.dmp'), new Date(2000), new Date(2000))
    expect(listCrashDumps(d).map((c) => c.name)).toEqual(['b.dmp', 'a.dmp'])
    expect(listCrashDumps(path.join(d, 'none'))).toEqual([])
  })
})
