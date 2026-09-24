import crypto from 'node:crypto'

/** Random url-safe id with a type prefix, e.g. `p_2k9x...`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(8).toString('base64url')}`
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}
