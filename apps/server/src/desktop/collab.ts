// Review comments and the activity feed on a linked desktop (carried from R2). They live in the cloud and don't sync:
// for a project or space that is in the cloud, the desktop asks the cloud (so it shows the same comments as the web,
// and comments made here land there), and while one is being read it follows the cloud's live `comment` updates and
// passes them to this computer's screens. Offline, comments say they need a connection; nothing is queued. A project
// or space that isn't in the cloud keeps its comments on this computer, as before linking.
import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { comments, projects } from '../db/schema'
import { log } from '../log'
import { CloudError } from './cloud'
import { kvGet, syncRow } from './db'
import { cloud } from './link'

export const desktopCollabRoutes = new Hono<AppEnv>()

const OFFLINE = { error: 'Comments are kept in the cloud, which can’t be reached right now. They show again when this computer is back online.', code: 'server' }

/** The project is in a cloud space and in the cloud: its comments are the cloud's. */
async function cloudProject(id: string): Promise<{ workspaceId: string } | null> {
  if (!cloud()) return null
  const row = (await ctx().db.select({ ws: projects.workspaceId }).from(projects).where(eq(projects.id, id)).limit(1))[0]
  if (!row || !((await kvGet<string[]>('cloudWorkspaces')) ?? []).includes(row.ws)) return null
  if ((await syncRow('project', id))?.cloudVersion == null) return null
  return { workspaceId: row.ws }
}

/** Ask the cloud the same thing; its answer (or refusal) goes back as it is. Offline: a 503 that says so. */
async function forward(c: Context<AppEnv>, path: string, workspaceId?: string): Promise<Response> {
  const client = cloud()!
  const method = c.req.method
  const text = method === 'GET' || method === 'DELETE' ? undefined : await c.req.text()
  let res: Response
  try {
    res = await client.request(method, path, { body: text || undefined, headers: text ? { 'content-type': 'application/json' } : {}, idleTimeoutMs: 30_000 })
  } catch (err) {
    if (err instanceof CloudError && err.offline) return c.json(OFFLINE, 503)
    throw err
  }
  const out = await res.text()
  if (!/^application\/json/i.test(res.headers.get('content-type') ?? '')) return c.json(OFFLINE, 503)
  if (res.ok && workspaceId) {
    follow(workspaceId)
    // this computer's screens hear of a change made here at once (the cloud's own update follows; it's the same)
    if (method !== 'GET') publishLocal(workspaceId, path, method, out)
  }
  return new Response(out, { status: res.status, headers: { 'content-type': 'application/json' } })
}

function publishLocal(workspaceId: string, path: string, method: string, out: string) {
  try {
    const body = JSON.parse(out) as { id?: string; projectId?: string; removed?: string[] }
    if (method === 'DELETE') {
      const projectId = commentProject.get(path.split('/').pop() ?? '')
      if (projectId) ctx().bus.publish(workspaceId, 'comment', { projectId, removed: body.removed ?? [] })
    } else if (body.projectId) ctx().bus.publish(workspaceId, 'comment', { projectId: body.projectId, comment: body })
  } catch {
    /* not a comment */
  }
}

/** Which project a cloud comment belongs to (learnt as comments pass through), so a delete can be announced here. */
const commentProject = new Map<string, string>()

function remember(out: string) {
  try {
    const list = JSON.parse(out) as Array<{ id: string; projectId: string }>
    if (Array.isArray(list)) for (const cm of list.slice(0, 2000)) commentProject.set(cm.id, cm.projectId)
  } catch {
    /* ignore */
  }
}

desktopCollabRoutes.get('/projects/:id/comments', async (c, next) => {
  requireUser(c)
  const p = await cloudProject(c.req.param('id'))
  if (!p) return next()
  const res = await forward(c, `/api/projects/${encodeURIComponent(c.req.param('id'))}/comments`, p.workspaceId)
  if (res.ok) remember(await res.clone().text())
  return res
})

desktopCollabRoutes.post('/projects/:id/comments', async (c, next) => {
  requireUser(c)
  const p = await cloudProject(c.req.param('id'))
  if (!p) return next()
  return forward(c, `/api/projects/${encodeURIComponent(c.req.param('id'))}/comments`, p.workspaceId)
})

/** A comment that isn't on this computer is a cloud one (while linked). */
async function cloudComment(id: string): Promise<{ workspaceId?: string } | null> {
  if (!cloud()) return null
  if ((await ctx().db.select({ id: comments.id }).from(comments).where(eq(comments.id, id)).limit(1)).length) return null
  const projectId = commentProject.get(id)
  const ws = projectId ? (await ctx().db.select({ ws: projects.workspaceId }).from(projects).where(eq(projects.id, projectId)).limit(1))[0]?.ws : undefined
  return { workspaceId: ws }
}

for (const method of ['patch', 'delete'] as const) {
  desktopCollabRoutes[method]('/comments/:id', async (c, next) => {
    requireUser(c)
    const cm = await cloudComment(c.req.param('id'))
    if (!cm) return next()
    return forward(c, `/api/comments/${encodeURIComponent(c.req.param('id'))}`, cm.workspaceId)
  })
}

desktopCollabRoutes.get('/workspaces/:id/activity', async (c, next) => {
  requireUser(c)
  const ws = c.req.param('id')
  if (!cloud() || !((await kvGet<string[]>('cloudWorkspaces')) ?? []).includes(ws)) return next()
  const q = new URL(c.req.url).search
  return forward(c, `/api/workspaces/${encodeURIComponent(ws)}/activity${q}`)
})

// ---------------- the cloud's live comment updates, passed on ----------------

/** How long a space's cloud stream stays open after its comments were last read here. */
const FOLLOW_MS = 30 * 60_000

const streams = new Map<string, { until: number; abort: AbortController }>()

/** Follow a space's cloud live updates for a while (its comments are being read here). */
export function follow(workspaceId: string) {
  const cur = streams.get(workspaceId)
  if (cur) {
    cur.until = Date.now() + FOLLOW_MS
    return
  }
  const s = { until: Date.now() + FOLLOW_MS, abort: new AbortController() }
  streams.set(workspaceId, s)
  void run(workspaceId, s)
}

/** Unlinked, or stopping: every cloud stream ends. */
export function stopFollowing() {
  for (const s of streams.values()) s.abort.abort()
  streams.clear()
}

export function following(): string[] {
  return [...streams.keys()]
}

async function run(workspaceId: string, s: { until: number; abort: AbortController }) {
  let wait = 2000
  let lastId = ''
  while (!s.abort.signal.aborted && Date.now() < s.until) {
    const client = cloud(s.abort.signal)
    if (!client) break
    try {
      const res = await client.request('GET', `/api/events?workspaceId=${encodeURIComponent(workspaceId)}${lastId ? `&lastEventId=${encodeURIComponent(lastId)}` : ''}`, { headers: { accept: 'text/event-stream' } })
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined)
        // no longer this account's space, or signed out: stop
        if (res.status === 401 || res.status === 403 || res.status === 404) break
        throw new Error(`HTTP ${res.status}`)
      }
      wait = 2000
      lastId = (await readEvents(res.body, s, (ev) => {
        if (ev.event === 'comment' && ev.data) ctx().bus.publish(workspaceId, 'comment', JSON.parse(ev.data))
      })) || lastId
    } catch (err) {
      if (s.abort.signal.aborted) break
      log.info('desktop: cloud live updates dropped; trying again', { workspaceId, err: String(err) })
    }
    await new Promise((r) => setTimeout(r, wait).unref?.())
    wait = Math.min(wait * 2, 60_000)
  }
  if (streams.get(workspaceId) === s) streams.delete(workspaceId)
}

/** Read a server-sent event stream until it ends (or following stops); returns the last event id seen. */
async function readEvents(body: ReadableStream<Uint8Array>, s: { until: number; abort: AbortController }, on: (ev: { event: string; data: string }) => void): Promise<string> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let lastId = ''
  const stop = setInterval(() => Date.now() > s.until && s.abort.abort(), 60_000)
  stop.unref?.()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
          else if (line.startsWith('id:')) lastId = line.slice(3).trim()
        }
        try {
          on({ event, data: data.join('\n') })
        } catch {
          /* a malformed event */
        }
      }
    }
  } finally {
    clearInterval(stop)
    await reader.cancel().catch(() => undefined)
  }
  return lastId
}
