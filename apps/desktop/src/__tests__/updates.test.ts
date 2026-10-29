// The update check: off for unsigned builds, asks the build's GitHub Releases feed, says a newer version exists and
// links to it, never downloads anything itself (D-4).
import { describe, expect, it, vi } from 'vitest'
import { checkForUpdate, compareVersions, parseRelease, releaseFeedUrl, updatesOffered } from '../updates'

const repo = 'producer-studio/desktop'
const release = (over: Record<string, unknown> = {}) => ({ tag_name: 'v0.8.0', name: 'Producer Studio 0.8.0', html_url: `https://github.com/${repo}/releases/tag/v0.8.0`, draft: false, prerelease: false, published_at: '2026-11-02T10:00:00Z', ...over })
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('update checks (D-4)', () => {
  it('are offered only on signed builds that name a feed', () => {
    expect(updatesOffered({ signed: false, updateRepo: repo })).toMatchObject({ offered: false, reason: expect.stringMatching(/signed builds/) })
    expect(updatesOffered({ signed: true })).toMatchObject({ offered: false, reason: expect.stringMatching(/release feed/) })
    expect(updatesOffered({ signed: true, updateRepo: repo })).toEqual({ offered: true })
  })

  it('compare versions by number, a pre-release before its release', () => {
    expect(compareVersions('0.10.0', '0.9.3')).toBeGreaterThan(0)
    expect(compareVersions('v1.2.0', '1.2')).toBe(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
  })

  it('a newer release is offered with its page; the same or older is "current"', async () => {
    const f = answer(release())
    const s = await checkForUpdate({ repo, current: '0.7.0', fetch: f, now: 5 })
    expect(s).toEqual({ status: 'available', checkedAt: 5, skipped: false, update: { version: '0.8.0', url: `https://github.com/${repo}/releases/tag/v0.8.0`, name: 'Producer Studio 0.8.0', publishedAt: '2026-11-02T10:00:00Z' } })
    expect(f).toHaveBeenCalledWith(releaseFeedUrl(repo), expect.objectContaining({ headers: expect.objectContaining({ 'user-agent': 'Producer-Studio/0.7.0' }) }))
    expect(releaseFeedUrl(repo)).toBe('https://api.github.com/repos/producer-studio/desktop/releases/latest')
    expect(await checkForUpdate({ repo, current: '0.8.0', fetch: answer(release()), now: 5 })).toEqual({ status: 'current', checkedAt: 5, latest: '0.8.0' })
  })

  it('a version the person skipped is marked skipped (not offered again by itself)', async () => {
    expect(await checkForUpdate({ repo, current: '0.7.0', skippedVersion: '0.8.0', fetch: answer(release()) })).toMatchObject({ status: 'available', skipped: true })
  })

  it('never links anywhere but this repository’s releases on github.com', () => {
    expect(parseRelease(release({ html_url: 'https://evil.example/releases/v0.8.0' }), repo)).toBeNull()
    expect(parseRelease(release({ html_url: `http://github.com/${repo}/releases/tag/v0.8.0` }), repo)).toBeNull()
    expect(parseRelease(release({ html_url: 'https://github.com/someone/else/releases/tag/v0.8.0' }), repo)).toBeNull()
    expect(parseRelease(release({ draft: true }), repo)).toBeNull()
    expect(parseRelease(release({ prerelease: true }), repo)).toBeNull()
    expect(parseRelease(release({ tag_name: 'nightly' }), repo)).toBeNull()
  })

  it('a feed that fails says why instead of throwing', async () => {
    expect(await checkForUpdate({ repo, current: '0.7.0', fetch: answer({ message: 'Not Found' }, 404) })).toMatchObject({ status: 'error', error: 'No release has been published yet.' })
    expect(await checkForUpdate({ repo, current: '0.7.0', fetch: answer({}, 503) })).toMatchObject({ status: 'error', error: expect.stringMatching(/answered 503/) })
    expect(await checkForUpdate({ repo, current: '0.7.0', fetch: answer({ hello: 1 }) })).toMatchObject({ status: 'error', error: expect.stringMatching(/wasn’t a release/) })
    const down = vi.fn(async () => Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof fetch
    expect(await checkForUpdate({ repo, current: '0.7.0', fetch: down })).toMatchObject({ status: 'error', error: expect.stringMatching(/Couldn’t reach the release feed \(getaddrinfo ENOTFOUND\)/) })
  })
})
