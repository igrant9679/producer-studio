// Cloud encryption at rest for provider API keys: AES-256-GCM with a 32-byte key from SECRETS_KEY (base64).
// The additional authenticated data binds each ciphertext to its workspace + provider, so a row copied onto another
// workspace or provider fails to decrypt. Development without SECRETS_KEY generates `<DATA_DIR>/secrets.key` once
// (with a warning); production refuses to store keys until SECRETS_KEY is set.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ctx } from '../context'
import { HttpError } from '../http'
import { log } from '../log'

export interface SealedKey {
  ciphertext: string
  iv: string
  tag: string
}

let cached: { env: string | undefined; key: Buffer } | undefined

function secretsKey(): Buffer {
  const env = process.env.SECRETS_KEY
  if (cached && cached.env === env) return cached.key
  let key: Buffer | undefined
  if (env) {
    const k = Buffer.from(env.trim(), 'base64')
    if (k.length !== 32) throw new HttpError(503, 'server', 'SECRETS_KEY must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)')
    key = k
  } else {
    const cfg = ctx().config
    if (cfg.production && cfg.mode === 'cloud') throw new HttpError(503, 'server', 'API keys can’t be stored: SECRETS_KEY is not set on this server')
    const file = path.join(cfg.dataDir, 'secrets.key')
    try {
      const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')
      if (k.length === 32) key = k
    } catch {
      /* create below */
    }
    if (!key) {
      key = crypto.randomBytes(32)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 })
      log.warn('SECRETS_KEY is not set: generated a development key for AI key encryption', { file })
    }
  }
  cached = { env, key }
  return key
}

export function sealKey(plain: string, aad: string): SealedKey {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', secretsKey(), iv)
  c.setAAD(Buffer.from(aad, 'utf8'))
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return { ciphertext: data.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') }
}

/** Decrypt, or undefined when SECRETS_KEY changed or the row was tampered with. */
export function openKey(s: SealedKey, aad: string): string | undefined {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', secretsKey(), Buffer.from(s.iv, 'base64'))
    d.setAAD(Buffer.from(aad, 'utf8'))
    d.setAuthTag(Buffer.from(s.tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(s.ciphertext, 'base64')), d.final()]).toString('utf8')
  } catch (err) {
    if (err instanceof HttpError) throw err
    log.warn('an AI key could not be decrypted (SECRETS_KEY changed?)')
    return undefined
  }
}

/** Test hook. */
export function resetSecretsKey() {
  cached = undefined
}
