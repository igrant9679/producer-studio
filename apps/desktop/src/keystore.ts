// A per-install 32-byte key, protected by the OS keystore through Electron safeStorage (DPAPI on Windows,
// Keychain on macOS, libsecret on Linux). The server uses it (DESKTOP_SECRET_KEY) to encrypt the cloud device token
// at rest. When safeStorage is unavailable we pass nothing and the server falls back to a key file (documented).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'

export function deviceKey(): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  const file = path.join(app.getPath('userData'), 'keystore.bin')
  try {
    if (fs.existsSync(file)) {
      const k = safeStorage.decryptString(fs.readFileSync(file))
      if (Buffer.from(k, 'base64').length === 32) return k
    }
  } catch {
    // unreadable (different OS user / reset keychain): start over; the server will ask to link again
  }
  const k = crypto.randomBytes(32).toString('base64')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, safeStorage.encryptString(k))
  return k
}
