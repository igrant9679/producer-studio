// A copy of the local database before the engine migrates it, the newest few kept (D-10).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { backupDatabase, dbDir, listBackups, needsBackup } from '../backup'
import { moveDataDir } from '../datadir'

function dataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bk-'))
  fs.mkdirSync(path.join(dbDir(d), 'base', '1'), { recursive: true })
  fs.writeFileSync(path.join(dbDir(d), 'PG_VERSION'), '17')
  fs.writeFileSync(path.join(dbDir(d), 'base', '1', '1259'), Buffer.alloc(8192, 7))
  fs.mkdirSync(path.join(d, 'media'))
  fs.writeFileSync(path.join(d, 'media', 'big.mp4'), Buffer.alloc(4096))
  return d
}

describe('when a backup is made (D-10)', () => {
  it('before a newer schema, or another version when the schema is unknown; never for a first start', () => {
    expect(needsBackup({ version: '0.6.1', schema: 15 }, { version: '0.7.0', schema: 16 }, true)).toBe(true)
    expect(needsBackup({ version: '0.7.0', schema: 16 }, { version: '0.7.1', schema: 16 }, true)).toBe(false)
    expect(needsBackup({ version: '0.6.1' }, { version: '0.7.0', schema: 16 }, true)).toBe(true)
    expect(needsBackup({ version: '0.7.0' }, { version: '0.7.0' }, true)).toBe(false)
    // an install from before this was recorded: may migrate, so keep a copy
    expect(needsBackup(undefined, { version: '0.7.0', schema: 16 }, true)).toBe(true)
    // nothing to keep yet
    expect(needsBackup(undefined, { version: '0.7.0', schema: 16 }, false)).toBe(false)
  })
})

describe('the backup', () => {
  it('copies the database folder (not media) under backups/, named by time and what it was before', () => {
    const d = dataDir()
    const b = backupDatabase(d, { label: 'before v0.7.0 (schema 16)', now: Date.UTC(2026, 9, 28, 9, 5, 7) })!
    expect(b.name).toBe('db-20261028T090507Z-before-v0.7.0-schema-16')
    expect(fs.readFileSync(path.join(b.dir, 'pg', 'PG_VERSION'), 'utf8')).toBe('17')
    expect(fs.statSync(path.join(b.dir, 'pg', 'base', '1', '1259')).size).toBe(8192)
    expect(fs.existsSync(path.join(b.dir, 'media'))).toBe(false)
    expect(b.bytes).toBe(8194)
    expect(b.at).toBe(Date.UTC(2026, 9, 28, 9, 5, 7))
  })

  it('keeps the newest three, newest first', () => {
    const d = dataDir()
    for (let i = 0; i < 5; i++) backupDatabase(d, { label: `v${i}`, now: Date.UTC(2026, 0, 1 + i) })
    expect(listBackups(d).map((b) => b.name.replace(/^db-\d+T\d+Z-/, ''))).toEqual(['v4', 'v3', 'v2'])
    backupDatabase(d, { label: 'one', keep: 1, now: Date.UTC(2026, 1, 1) })
    expect(listBackups(d)).toHaveLength(1)
  })

  it('no database yet: nothing to copy', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bk-'))
    expect(backupDatabase(d, { label: 'x' })).toBeNull()
    expect(listBackups(d)).toEqual([])
  })

  it('a copy that fails is removed and the database is untouched', () => {
    const d = dataDir()
    const now = Date.UTC(2026, 2, 3)
    // the same name already taken: the copy refuses to overwrite, and leaves no half backup of its own
    const first = backupDatabase(d, { label: 'same', now })!
    fs.writeFileSync(path.join(first.dir, 'marker'), 'mine')
    expect(() => backupDatabase(d, { label: 'same', now })).toThrow()
    expect(fs.existsSync(path.join(dbDir(d), 'PG_VERSION'))).toBe(true)
  })

  it('Move data folder takes the backups with it (it copies everything, phase 4)', async () => {
    const d = dataDir()
    backupDatabase(d, { label: 'before', now: Date.UTC(2026, 3, 4) })
    const to = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bk-to-')), 'moved')
    const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bk-s-')), 'settings.json')
    await moveDataDir(settings, d, to)
    expect(listBackups(to).map((b) => b.name)).toEqual(['db-20260404T000000Z-before'])
    expect(fs.readFileSync(path.join(to, 'media', 'big.mp4')).length).toBe(4096)
    expect(fs.existsSync(d)).toBe(false)
  })
})
