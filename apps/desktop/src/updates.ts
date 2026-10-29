// Update check (D-4). electron-updater isn't a dependency and Electron's own autoUpdater doesn't drive NSIS installs,
// so the app asks the GitHub Releases feed named at build time (build-info.json updateRepo) whether a newer version
// exists, tells the person and links to its release page; nothing is downloaded or installed by itself. Offered only
// on signed builds (an unsigned installer would meet SmartScreen anyway), behind Settings → This computer. No
// Electron here, so it can be tested with a stand-in fetch.
import type { BuildInfo } from './build-info'

export interface UpdateInfo {
  version: string
  /** The release page on github.com (checked to belong to the feed's repository). */
  url: string
  name?: string
  publishedAt?: string
}

export type UpdateState =
  | { status: 'idle' }
  | { status: 'current'; checkedAt: number; latest: string }
  | { status: 'available'; checkedAt: number; update: UpdateInfo; skipped: boolean }
  | { status: 'error'; checkedAt: number; error: string }

/** Whether this build can check at all, and why not. */
export function updatesOffered(build: Pick<BuildInfo, 'signed' | 'updateRepo'>): { offered: boolean; reason?: string } {
  if (!build.signed) return { offered: false, reason: 'Update checks come with signed builds, and this one isn’t signed. New versions are on the download page.' }
  if (!build.updateRepo) return { offered: false, reason: 'This build doesn’t name a release feed. New versions are on the download page.' }
  return { offered: true }
}

/** Numeric comparison of dotted versions ("0.10.0" > "0.9.3"); a pre-release ("1.0.0-beta.1") sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre] = v.replace(/^v/i, '').split('-', 2)
    return { parts: main.split('.').map((x) => Number.parseInt(x, 10) || 0), pre }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0)
    if (d) return d
  }
  if (x.pre && !y.pre) return -1
  if (!x.pre && y.pre) return 1
  return (x.pre ?? '').localeCompare(y.pre ?? '', undefined, { numeric: true })
}

/** A published, non-draft, non-prerelease GitHub release of `repo`, or null for anything else. */
export function parseRelease(raw: unknown, repo: string): UpdateInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.draft === true || r.prerelease === true) return null
  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : ''
  const version = tag.replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+([-.][\w.]+)?$/.test(version)) return null
  let url: URL
  try {
    url = new URL(String(r.html_url ?? ''))
  } catch {
    return null
  }
  // only ever link to this repository's releases on github.com
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/releases/`)) return null
  const info: UpdateInfo = { version, url: url.toString() }
  if (typeof r.name === 'string' && r.name.trim()) info.name = r.name.trim().slice(0, 200)
  if (typeof r.published_at === 'string') info.publishedAt = r.published_at
  return info
}

export const releaseFeedUrl = (repo: string) => `https://api.github.com/repos/${repo}/releases/latest`

/** Ask the feed for its latest release and compare it with `current`. Never throws: failures come back as a state. */
export async function checkForUpdate(o: { repo: string; current: string; skippedVersion?: string; fetch?: typeof fetch; now?: number }): Promise<UpdateState> {
  const now = o.now ?? Date.now()
  try {
    const res = await (o.fetch ?? fetch)(releaseFeedUrl(o.repo), {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `Producer-Studio/${o.current}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 404) return { status: 'error', checkedAt: now, error: 'No release has been published yet.' }
    if (!res.ok) return { status: 'error', checkedAt: now, error: `The release feed answered ${res.status}. Try again later.` }
    const update = parseRelease(await res.json(), o.repo)
    if (!update) return { status: 'error', checkedAt: now, error: 'The release feed’s answer wasn’t a release this app can use.' }
    if (compareVersions(update.version, o.current) <= 0) return { status: 'current', checkedAt: now, latest: update.version }
    return { status: 'available', checkedAt: now, update, skipped: update.version === o.skippedVersion }
  } catch (err) {
    return { status: 'error', checkedAt: now, error: `Couldn’t reach the release feed (${(err as Error).message}).` }
  }
}

/** A check is due: at start (after a short wait) and then once a day, while the setting is on. */
export const UPDATE_FIRST_CHECK_MS = 30_000
export const UPDATE_INTERVAL_MS = 24 * 60 * 60_000
