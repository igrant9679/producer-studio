// A space's settings (pronunciations, sample project) and each member's (favourite voices, Voice Studio draft,
// onboarding) on a linked desktop (phase 5 carry-over). They live in the cloud and don't sync: for a space that is in
// the cloud, the desktop reads and writes them there, so they are the same on the web and on every computer. Offline,
// or for a space that isn't in the cloud, this computer's own copy answers, as before linking (a change made offline
// stays on this computer).
import { Hono, type Context } from 'hono'
import { type AppEnv, requireUser } from '../auth'
import { log } from '../log'
import { CloudError } from './cloud'
import { kvGet } from './db'
import { cloud } from './link'

export const desktopSettingsRoutes = new Hono<AppEnv>()

/** The cloud's answer, or undefined (offline, or not something to pass on) so this computer's copy answers instead. */
async function fromCloud(c: Context<AppEnv>, path: string): Promise<Response | undefined> {
  const client = cloud()
  if (!client) return undefined
  const method = c.req.method
  const text = method === 'GET' ? undefined : await c.req.text()
  try {
    const res = await client.request(method, path, { body: text || undefined, headers: text ? { 'content-type': 'application/json' } : {}, idleTimeoutMs: 20_000 })
    if (!/^application\/json/i.test(res.headers.get('content-type') ?? '')) return undefined
    return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } })
  } catch (err) {
    if (!(err instanceof CloudError && err.offline)) log.warn('cloud settings request failed; using this computer’s', { path, err })
    return undefined
  }
}

for (const name of ['voice-settings', 'voice-studio', 'onboarding'] as const) {
  for (const method of ['get', 'put'] as const) {
    desktopSettingsRoutes[method](`/workspaces/:id/${name}`, async (c, next) => {
      requireUser(c)
      const ws = c.req.param('id')
      if (!cloud() || !((await kvGet<string[]>('cloudWorkspaces')) ?? []).includes(ws)) return next()
      return (await fromCloud(c, `/api/workspaces/${encodeURIComponent(ws)}/${name}`)) ?? next()
    })
  }
}
