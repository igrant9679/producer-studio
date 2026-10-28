// The data folder (database, media, renders: often GBs). New installs keep it in Local AppData on Windows (Roaming
// AppData is copied at every sign-in on managed PCs and counts against profile quotas); an install that already has
// one keeps it where it is. "Move data folder" copies it, checks the copy, switches, and only then removes the old
// one. A folder that can't be opened (an unplugged drive) is reported, with the default folder offered instead.
// No Electron here, so it can be tested on its own.
import fs from 'node:fs'
import path from 'node:path'

export interface DataDirEnv {
  platform: NodeJS.Platform
  /** Electron's userData (Roaming AppData on Windows): settings.json and logs stay here. */
  userData: string
  /** %LOCALAPPDATA% on Windows. */
  localAppData?: string
}

/** Where a new install keeps its data. */
export function defaultDataDir(env: DataDirEnv): string {
  if (env.platform === 'win32' && env.localAppData) return path.join(env.localAppData, path.basename(env.userData), 'data')
  return path.join(env.userData, 'data')
}

/** Where installs before this kept it (inside userData). */
export const legacyDataDir = (env: DataDirEnv) => path.join(env.userData, 'data')

export function readSettings(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Change keys of settings.json, keeping the rest (the local engine keeps its own settings in the same file). */
export function writeSettings(file: string, patch: Record<string, unknown>) {
  const next = { ...readSettings(file), ...patch }
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file)
}

const hasEntries = (dir: string) => {
  try {
    return fs.readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/**
 * The data folder for this launch: the one in settings.json; else an earlier install's (kept where it is); else the
 * default for a new install. The choice is written to settings.json so it never changes on its own afterwards.
 */
export function resolveDataDir(settingsFile: string, env: DataDirEnv): string {
  const s = readSettings(settingsFile)
  if (typeof s.dataDir === 'string' && path.isAbsolute(s.dataDir)) return s.dataDir
  const dir = hasEntries(legacyDataDir(env)) ? legacyDataDir(env) : defaultDataDir(env)
  try {
    writeSettings(settingsFile, { dataDir: dir })
  } catch {
    /* read-only profile: the same choice is made next time */
  }
  return dir
}

/** Why the data folder can't be used right now (a drive that isn't connected, no permission), or null. */
export function dataDirProblem(dir: string): string | null {
  const root = path.parse(dir).root
  if (root && !fs.existsSync(root)) return `the drive ${root} isn’t connected`
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-test-${process.pid}`)
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
    return null
  } catch (err) {
    return (err as Error).message
  }
}

const inside = (child: string, parent: string) => {
  const r = path.relative(parent, child)
  return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r))
}

/** Every file under `dir`, relative path → size. */
function inventory(dir: string): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.set(path.relative(dir, p), fs.statSync(p).size)
    }
  }
  walk(dir)
  return out
}

/** What's wrong with moving `from` to `to`, or null. */
export function moveProblem(from: string, to: string): string | null {
  if (!path.isAbsolute(to)) return 'Choose a full folder path.'
  if (path.resolve(from) === path.resolve(to)) return 'That is already the data folder.'
  if (inside(to, from)) return 'The new folder can’t be inside the current data folder.'
  if (inside(from, to)) return 'The new folder can’t contain the current data folder.'
  if (hasEntries(to)) return 'Choose an empty folder (or a new one).'
  return dataDirProblem(to)
}

/**
 * Copy the data folder to `to` and check the copy (every file there, same size). On any failure the copy is removed
 * and the current folder is untouched. Switching (settings.json) and removing the old folder are separate steps, so
 * nothing is lost if the app stops in between.
 */
export async function copyDataDir(from: string, to: string, onProgress?: (done: number, total: number) => void): Promise<void> {
  const problem = moveProblem(from, to)
  if (problem) throw new Error(problem)
  const want = inventory(from)
  const total = [...want.values()].reduce((a, b) => a + b, 0)
  let done = 0
  try {
    fs.mkdirSync(to, { recursive: true })
    for (const [rel, size] of want) {
      const dest = path.join(to, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      await fs.promises.copyFile(path.join(from, rel), dest)
      done += size
      onProgress?.(done, total)
    }
    const got = inventory(to)
    for (const [rel, size] of want) if (got.get(rel) !== size) throw new Error(`The copy of ${rel} doesn’t match the original.`)
  } catch (err) {
    fs.rmSync(to, { recursive: true, force: true })
    throw err
  }
}

/** The whole move: copy and check, switch settings.json, then remove the old folder (left in place if that fails). */
export async function moveDataDir(settingsFile: string, from: string, to: string, onProgress?: (done: number, total: number) => void): Promise<{ removedOld: boolean }> {
  await copyDataDir(from, to, onProgress)
  writeSettings(settingsFile, { dataDir: to })
  try {
    fs.rmSync(from, { recursive: true, force: true })
    return { removedOld: true }
  } catch {
    return { removedOld: false }
  }
}
