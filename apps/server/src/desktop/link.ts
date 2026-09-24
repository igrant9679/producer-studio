// The current cloud link (URL, account, device token), loaded from desktop_kv and decrypted in memory only.
import { CloudClient } from './cloud'
import { kvDelete, kvGet, kvSet } from './db'
import { type Sealed, seal, unseal } from './secrets'

export interface StoredLink {
  cloudUrl: string
  account: string
  cloudUserId: string
  deviceId: string
  token: Sealed
  linkedAt: number
}

let current: { link: StoredLink; token: string } | undefined

export async function loadLink(): Promise<StoredLink | undefined> {
  const link = await kvGet<StoredLink>('link')
  if (!link) {
    current = undefined
    return undefined
  }
  const token = unseal(link.token)
  current = token ? { link, token } : undefined
  return link
}

export async function saveLink(l: Omit<StoredLink, 'token'>, token: string) {
  const link: StoredLink = { ...l, token: seal(token) }
  await kvSet('link', link)
  // remembered after unlink so relinking the same account keeps sync state
  await kvSet('lastLink', { cloudUrl: l.cloudUrl, cloudUserId: l.cloudUserId })
  current = { link, token }
}

export async function clearLink() {
  await kvDelete('link')
  current = undefined
}

export function linkInfo(): StoredLink | undefined {
  return current?.link
}

/** Client for the linked cloud, or undefined when not linked (or the token can't be decrypted). */
export function cloud(): CloudClient | undefined {
  return current ? new CloudClient(current.link.cloudUrl, current.token) : undefined
}
