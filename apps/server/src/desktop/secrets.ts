// Encryption at rest for the cloud device token (AES-256-GCM).
// The key comes from the Electron main process (DESKTOP_SECRET_KEY, base64 32 bytes): main generates it once and
// keeps it protected by the OS keystore via Electron safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on
// Linux), handing it to the server only through the child's environment. Without Electron (dev scripts, tests) the key
// falls back to a random file in the data folder — that protects nothing against someone who can read the data folder,
// and the status says so.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ctx } from '../context'

export interface Sealed {
  v: 1
  iv: string
  tag: string
  data: string
  /** 'os' = key protected by the OS keystore (safeStorage); 'file' = key stored next to the data. */
  protection: 'os' | 'file'
}

function key(): { key: Buffer; protection: Sealed['protection'] } {
  const env = process.env.DESKTOP_SECRET_KEY
  if (env) {
    const k = Buffer.from(env, 'base64')
    if (k.length === 32) return { key: k, protection: 'os' }
  }
  const file = path.join(ctx().config.dataDir, '.device-key')
  try {
    const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')
    if (k.length === 32) return { key: k, protection: 'file' }
  } catch {
    /* create below */
  }
  const k = crypto.randomBytes(32)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, k.toString('base64'), { mode: 0o600 })
  return { key: k, protection: 'file' }
}

export function seal(plain: string): Sealed {
  const { key: k, protection } = key()
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', k, iv)
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'), protection }
}

/** Decrypt, or undefined when the key changed (e.g. a different OS user) or the blob is corrupt. */
export function unseal(s: Sealed | undefined): string | undefined {
  if (!s || s.v !== 1) return undefined
  try {
    const { key: k } = key()
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(s.iv, 'base64'))
    d.setAuthTag(Buffer.from(s.tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8')
  } catch {
    return undefined
  }
}
