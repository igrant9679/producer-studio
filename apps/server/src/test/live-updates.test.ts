// Live updates that resume after a reconnect and close when access changes (P-16).
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ctx } from '../context'
import { REPLAY_MAX_EVENTS, REPLAY_MAX_MS } from '../events'
import { type Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

interface Sse {
  /** Events read so far: name, id and data. */
  events: Array<{ event: string; id?: string; data: string }>
  /** Resolves true when the server ends the stream. */
  ended: Promise<boolean>
  until: (pred: (e: Sse['events']) => boolean, ms?: number) => Promise<void>
  stop: () => void
}

async function open(client: Client, workspaceId: string, headers: Record<string, string> = {}, query = ''): Promise<Sse & { status: number }> {
  const res = await client.req('GET', `/api/events?workspaceId=${workspaceId}${query}`, undefined, headers)
  const events: Sse['events'] = []
  if (res.status !== 200) return { status: res.status, events, ended: Promise.resolve(true), until: async () => undefined, stop: () => undefined }
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const ended = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return true
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const e: { event: string; id?: string; data: string } = { event: 'message', data: '' }
          let any = false
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) ((e.event = line.slice(6).trim()), (any = true))
            else if (line.startsWith('id:')) e.id = line.slice(3).trim()
            else if (line.startsWith('data:')) e.data += line.slice(5).trim()
          }
          if (any) events.push(e)
        }
      }
    } catch {
      return true
    }
  })()
  const until = async (pred: (e: Sse['events']) => boolean, ms = 5000) => {
    const t0 = Date.now()
    while (!pred(events)) {
      if (Date.now() - t0 > ms) throw new Error(`timed out; got ${JSON.stringify(events.map((x) => x.event))}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return { status: res.status, events, ended, until, stop: () => void reader.cancel().catch(() => undefined) }
}

const projectEvents = (s: Sse) => s.events.filter((e) => e.event === 'project').map((e) => JSON.parse(e.data) as { id: string; version: number })

describe('live updates after a reconnect', () => {
  it('every event has an id, and reconnecting with the last one sends what was missed, once', async () => {
    const { client, workspaceId } = await signup(t.app)
    const first = await open(client, workspaceId)
    await first.until((e) => e.some((x) => x.event === 'ready'))
    const ready = first.events.find((x) => x.event === 'ready')!
    expect(ready.id).toMatch(/\.\d+$/)
    const { project, version } = (await client.json('POST', '/api/projects', { workspaceId, name: 'One' })).body
    await first.until((e) => e.some((x) => x.event === 'project'))
    const seen = first.events.filter((x) => x.event === 'project')
    expect(seen[0].id).toBeTruthy()
    first.stop()
    // while away: two saves
    const v2 = (await client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, background: '#111111' }, baseVersion: version })).body.version
    const v3 = (await client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, background: '#222222' }, baseVersion: v2 })).body.version
    const again = await open(client, workspaceId, { 'Last-Event-ID': seen[seen.length - 1].id! })
    await again.until((e) => e.some((x) => x.event === 'ready'))
    expect(projectEvents(again).map((p) => p.version)).toEqual([v2, v3])
    expect(again.events.some((x) => x.event === 'resync')).toBe(false)
    // the query parameter works the same (a reconnect the page makes itself)
    const third = await open(client, workspaceId, {}, `&lastEventId=${encodeURIComponent(ready.id!)}`)
    await third.until((e) => e.some((x) => x.event === 'ready'))
    expect(projectEvents(third).map((p) => p.version)).toEqual([version, v2, v3])
    again.stop()
    third.stop()
  })

  it('says resync when what was missed can’t be told', async () => {
    const { client, workspaceId } = await signup(t.app)
    // another server's (or an earlier run's) id
    const other = await open(client, workspaceId, { 'Last-Event-ID': 'w_elsewhere.12' })
    await other.until((e) => e.some((x) => x.event === 'ready'))
    expect(other.events[0].event).toBe('resync')
    other.stop()
    // events after it have left the buffer
    const first = await open(client, workspaceId)
    await first.until((e) => e.some((x) => x.event === 'ready'))
    const at = first.events.find((x) => x.event === 'ready')!.id!
    first.stop()
    for (let i = 0; i <= REPLAY_MAX_EVENTS; i++) ctx().bus.publish(workspaceId, 'sync', { n: i })
    const late = await open(client, workspaceId, { 'Last-Event-ID': at })
    await late.until((e) => e.some((x) => x.event === 'ready'))
    expect(late.events[0].event).toBe('resync')
    expect(late.events.filter((x) => x.event === 'sync')).toHaveLength(0)
    late.stop()
  })

  it('a quiet workspace lets go of old events, and a resume from before them is told to resync', () => {
    const bus = ctx().bus
    const at = bus.cursor()
    bus.publish('ws_quiet', 'sync', { n: 1 })
    expect(bus.replay('ws_quiet', at)).toHaveLength(1)
    const now = Date.now()
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + REPLAY_MAX_MS + 1000)
    try {
      bus.publish('ws_busy', 'sync', { n: 2 })
      expect(bus.replay('ws_quiet', at)).toBeNull()
    } finally {
      later.mockRestore()
    }
  })

  it('momentary events are sent live but not replayed', async () => {
    const { client, workspaceId } = await signup(t.app)
    const s = await open(client, workspaceId)
    await s.until((e) => e.some((x) => x.event === 'ready'))
    const at = s.events.find((x) => x.event === 'ready')!.id!
    ctx().bus.publish(workspaceId, 'sync', { live: true }, { replay: false })
    await s.until((e) => e.some((x) => x.event === 'sync'))
    s.stop()
    const again = await open(client, workspaceId, { 'Last-Event-ID': at })
    await again.until((e) => e.some((x) => x.event === 'ready'))
    expect(again.events.filter((x) => x.event === 'sync')).toHaveLength(0)
    again.stop()
  })
})

describe('live updates close when access changes', () => {
  async function team(role: 'editor' | 'viewer') {
    const A = await signup(t.app, 'Owner')
    const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Team' })).body as { id: string }
    const M = await signup(t.app, 'Member')
    const inv = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: M.email, role })
    await M.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
    const userId = (await M.client.json('GET', '/api/auth/me')).body.user.id as string
    return { A, M: { ...M, userId }, wsId: ws.id }
  }
  const closedWithin = (s: Sse, ms = 5000) => Promise.race([s.ended, new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

  it('when the reader’s role is lowered', async () => {
    const { A, M, wsId } = await team('editor')
    const s = await open(M.client, wsId)
    await s.until((e) => e.some((x) => x.event === 'ready'))
    expect((await A.client.json('PATCH', `/api/workspaces/${wsId}/members/${M.userId}`, { role: 'viewer' })).status).toBe(200)
    expect(await closedWithin(s)).toBe(true)
    // the screen reconnects and carries on as a viewer
    const again = await open(M.client, wsId)
    expect(again.status).toBe(200)
    again.stop()
  })

  it('stays open when the role is raised', async () => {
    const { A, M, wsId } = await team('viewer')
    const s = await open(M.client, wsId)
    await s.until((e) => e.some((x) => x.event === 'ready'))
    await A.client.json('PATCH', `/api/workspaces/${wsId}/members/${M.userId}`, { role: 'editor' })
    await s.until((e) => e.some((x) => x.event === 'workspace'))
    expect(await closedWithin(s, 400)).toBe(false)
    s.stop()
  })

  it('when the reader signs out', async () => {
    const { client, workspaceId } = await signup(t.app)
    const cookie = client.cookie
    const s = await open(client, workspaceId)
    await s.until((e) => e.some((x) => x.event === 'ready'))
    await client.json('POST', '/api/auth/logout')
    expect(await closedWithin(s)).toBe(true)
    client.cookie = cookie
    expect((await open(client, workspaceId)).status).toBe(401)
  })
})
