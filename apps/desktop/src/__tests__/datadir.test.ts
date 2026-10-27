// Where the data folder lives (DSK-17), moving it (copy, check, switch, remove), and a folder that can't be opened (DSK-30).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { copyDataDir, dataDirProblem, defaultDataDir, moveDataDir, moveProblem, readSettings, resolveDataDir } from '../datadir'

let root = ''
let env: { platform: NodeJS.Platform; userData: string; localAppData: string }
let settingsFile = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-datadir-'))
  env = { platform: 'win32', userData: path.join(root, 'Roaming', 'Producer Studio'), localAppData: path.join(root, 'Local') }
  settingsFile = path.join(env.userData, 'settings.json')
})

const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('the data folder of a new or an existing install (DSK-17)', () => {
  it('a new install keeps its data in Local AppData, and remembers that', () => {
    const dir = resolveDataDir(settingsFile, env)
    expect(dir).toBe(path.join(root, 'Local', 'Producer Studio', 'data'))
    expect(readSettings(settingsFile).dataDir).toBe(dir)
  })

  it('an existing install keeps its folder in Roaming AppData (nothing moves on its own)', () => {
    put(path.join(env.userData, 'data', 'pglite', 'base'), 'db')
    put(settingsFile, JSON.stringify({ autoSync: true }))
    const dir = resolveDataDir(settingsFile, env)
    expect(dir).toBe(path.join(env.userData, 'data'))
    expect(readSettings(settingsFile)).toEqual({ autoSync: true, dataDir: dir })
  })

  it('a folder chosen in settings wins; other platforms keep it in userData', () => {
    put(settingsFile, JSON.stringify({ dataDir: path.join(root, 'D', 'Media') }))
    expect(resolveDataDir(settingsFile, env)).toBe(path.join(root, 'D', 'Media'))
    expect(defaultDataDir({ platform: 'darwin', userData: '/Users/a/Library/Application Support/Producer Studio' })).toBe(path.join('/Users/a/Library/Application Support/Producer Studio', 'data'))
  })
})

describe('Move data folder (DSK-17)', () => {
  it('copies everything, checks it, switches settings and removes the old folder', async () => {
    const from = path.join(env.userData, 'data')
    put(path.join(from, 'pglite', 'base', '1'), 'x'.repeat(1000))
    put(path.join(from, 'storage', 'ws', 'w1', 'assets', 'a1', 'source.mp4'), 'v'.repeat(5000))
    put(settingsFile, JSON.stringify({ dataDir: from, mediaSync: 'all' }))
    const to = path.join(root, 'Local', 'Producer Studio', 'data')
    const seen: number[] = []
    const r = await moveDataDir(settingsFile, from, to, (done) => seen.push(done))
    expect(r.removedOld).toBe(true)
    expect(fs.readFileSync(path.join(to, 'storage', 'ws', 'w1', 'assets', 'a1', 'source.mp4'), 'utf8')).toHaveLength(5000)
    expect(fs.existsSync(from)).toBe(false)
    expect(readSettings(settingsFile)).toEqual({ dataDir: to, mediaSync: 'all' })
    expect(seen.at(-1)).toBe(6000)
  })

  it('refuses a folder inside the current one, or one with things in it, and leaves everything as it was', async () => {
    const from = path.join(root, 'data')
    put(path.join(from, 'a.txt'), 'a')
    expect(moveProblem(from, path.join(from, 'sub'))).toMatch(/inside/)
    expect(moveProblem(from, root)).toMatch(/contain/)
    put(path.join(root, 'busy', 'x'), 'x')
    expect(moveProblem(from, path.join(root, 'busy'))).toMatch(/empty/)
    await expect(copyDataDir(from, path.join(from, 'sub'))).rejects.toThrow(/inside/)
    expect(fs.readFileSync(path.join(from, 'a.txt'), 'utf8')).toBe('a')
  })

  it('a copy that fails half way is removed; the old folder is untouched', async () => {
    const from = path.join(root, 'data')
    put(path.join(from, 'a.txt'), 'a')
    put(path.join(from, 'b.txt'), 'b')
    // the target can't take a file where a folder must go
    const to = path.join(root, 'new')
    const realCopy = fs.promises.copyFile
    let n = 0
    fs.promises.copyFile = (async (src: fs.PathLike, dest: fs.PathLike) => {
      if (++n === 2) throw new Error('disk full')
      return realCopy(src, dest)
    }) as typeof fs.promises.copyFile
    try {
      await expect(moveDataDir(settingsFile, from, to)).rejects.toThrow('disk full')
    } finally {
      fs.promises.copyFile = realCopy
    }
    expect(fs.existsSync(to)).toBe(false)
    expect(fs.readdirSync(from).sort()).toEqual(['a.txt', 'b.txt'])
    expect(readSettings(settingsFile).dataDir).toBeUndefined()
  })
})

describe('a data folder that can’t be opened (DSK-30)', () => {
  it('names the problem instead of failing to start', () => {
    expect(dataDirProblem(path.join(root, 'fine'))).toBeNull()
    // a "folder" whose parent is a file: like a path on a drive that's gone
    put(path.join(root, 'file'), 'x')
    expect(dataDirProblem(path.join(root, 'file', 'data'))).toEqual(expect.any(String))
    if (process.platform === 'win32') {
      const free = 'QRSTUVWXYZ'.split('').find((l) => !fs.existsSync(`${l}:\\`))
      if (free) expect(dataDirProblem(`${free}:\\Producer\\data`)).toMatch(/isn’t connected/)
    }
  })
})
