// A per-install 32-byte key, protected by the OS keystore through Electron safeStorage (DPAPI on Windows,
// Keychain on macOS, libsecret on Linux). The server uses it (DESKTOP_SECRET_KEY) to encrypt the cloud device token
// and the saved AI keys at rest. When safeStorage is unavailable we pass nothing and the server falls back to a key
// file (documented). A keystore that can't be decrypted is never replaced on its own: everything sealed with it would
// be unreadable for good, and the cause can be temporary (a locked keychain, a profile that isn't fully loaded). We
// keep a copy, run without it this launch and tell the person, who can choose to start over (resetDeviceKey).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'

export interface KeystoreProblem {
  error: string
  file: string
  /** Byte-identical copy of the unreadable keystore (undefined if the copy couldn't be made). */
  backup?: string
}

let problem: KeystoreProblem | undefined

const keystoreFile = () => path.join(app.getPath('userData'), 'keystore.bin')

/** Why the saved key couldn't be used at the last deviceKey() call; undefined when it could (or there was none yet). */
export function keystoreProblem(): KeystoreProblem | undefined {
  return problem
}

function writeNewKey(file: string): string {
  const k = crypto.randomBytes(32).toString('base64')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // write then rename, so a crash mid-write can't leave a half-written keystore behind
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, safeStorage.encryptString(k))
  fs.renameSync(tmp, file)
  return k
}

/** Copy the keystore to keystore.bin.unreadable-<time> (reusing an identical copy from an earlier launch). */
function backUp(file: string, bytes: Buffer): string | undefined {
  try {
    const dir = path.dirname(file)
    const prefix = `${path.basename(file)}.unreadable-`
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(prefix) && fs.readFileSync(path.join(dir, name)).equals(bytes)) return path.join(dir, name)
    }
    const copy = path.join(dir, `${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}`)
    fs.writeFileSync(copy, bytes, { flag: 'wx' })
    return copy
  } catch {
    return undefined
  }
}

/** The key for this launch, or undefined (no safeStorage, or the saved key can't be read: see keystoreProblem()). */
export function deviceKey(): string | undefined {
  problem = undefined
  if (!safeStorage.isEncryptionAvailable()) return undefined
  const file = keystoreFile()
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return writeNewKey(file) // first run
    problem = { error: (err as Error).message, file }
    return undefined
  }
  let error: string
  try {
    const k = safeStorage.decryptString(bytes)
    if (Buffer.from(k, 'base64').length === 32) return k
    error = 'the saved key is not 32 bytes'
  } catch (err) {
    error = (err as Error).message || String(err)
  }
  // keystore.bin stays exactly as it is, so a later launch can still read it; the copy guards against anything else
  problem = { error, file, backup: backUp(file, bytes) }
  return undefined
}

/** Start over with a new key, at the person's request. The old keystore is copied first and kept. */
export function resetDeviceKey(): void {
  if (!safeStorage.isEncryptionAvailable()) return
  const file = keystoreFile()
  let bytes: Buffer | undefined
  try {
    bytes = fs.readFileSync(file)
  } catch {
    /* nothing to keep */
  }
  if (bytes && !backUp(file, bytes)) throw new Error(`Couldn’t copy ${file}, so it was left as it is.`)
  writeNewKey(file)
  problem = undefined
}
