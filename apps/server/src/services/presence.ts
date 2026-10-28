// Who has a project open now (A-23). Each open editor tab says so every PRESENCE_BEAT_MS and says goodbye when it
// closes; a tab that stops beating is gone after PRESENCE_TTL_MS. Kept in memory by the API process (the one that
// serves the live-update streams), and every change in who is there goes out as a `presence` event on the space's
// stream. Several API replicas would each know only their own visitors.
import type { PresenceEntry, ProjectPresence, Role } from '@producer/core'
import { PRESENCE_TTL_MS } from '@producer/core'
import { ctx } from '../context'

interface Tab {
  userId: string
  name: string
  color: string
  role: Role
  since: number
  seen: number
}

const rooms = new Map<string, { workspaceId: string; tabs: Map<string, Tab> }>()
let sweeper: ReturnType<typeof setInterval> | undefined

function people(tabs: Map<string, Tab>): PresenceEntry[] {
  const byUser = new Map<string, PresenceEntry>()
  for (const t of tabs.values()) {
    const cur = byUser.get(t.userId)
    if (!cur) byUser.set(t.userId, { userId: t.userId, name: t.name, color: t.color, role: t.role, since: t.since })
    else cur.since = Math.min(cur.since, t.since)
  }
  return [...byUser.values()].sort((a, b) => a.since - b.since || a.userId.localeCompare(b.userId))
}

const signature = (tabs: Map<string, Tab>) => people(tabs).map((p) => `${p.userId}:${p.role}`).join(',')

export function presenceOf(projectId: string): ProjectPresence {
  const room = rooms.get(projectId)
  return { projectId, people: room ? people(room.tabs) : [] }
}

function announce(projectId: string, workspaceId: string) {
  ctx().bus.publish(workspaceId, 'presence', presenceOf(projectId))
}

/** Drop tabs that stopped beating; tell the space when that changed who is there. */
export function sweepPresence(now = Date.now()) {
  for (const [projectId, room] of rooms) {
    const before = signature(room.tabs)
    for (const [k, t] of room.tabs) if (now - t.seen > PRESENCE_TTL_MS) room.tabs.delete(k)
    if (signature(room.tabs) !== before) announce(projectId, room.workspaceId)
    if (!room.tabs.size) rooms.delete(projectId)
  }
  if (!rooms.size && sweeper) {
    clearInterval(sweeper)
    sweeper = undefined
  }
}

/** A tab's heartbeat (`open`) or goodbye. Returns who is there now. */
export function beat(project: { id: string; workspaceId: string }, user: { id: string; name: string; avatarColor: string }, role: Role, client: string, open: boolean, now = Date.now()): ProjectPresence {
  let room = rooms.get(project.id)
  if (!room) {
    if (!open) return presenceOf(project.id)
    room = { workspaceId: project.workspaceId, tabs: new Map() }
    rooms.set(project.id, room)
  }
  const before = signature(room.tabs)
  // one person's tabs can't stand in for, or close, anyone else's
  const key = `${user.id}:${client}`
  if (open) {
    const t = room.tabs.get(key)
    if (t) Object.assign(t, { seen: now, role, name: user.name, color: user.avatarColor })
    else room.tabs.set(key, { userId: user.id, name: user.name, color: user.avatarColor, role, since: now, seen: now })
  } else room.tabs.delete(key)
  if (signature(room.tabs) !== before) announce(project.id, project.workspaceId)
  if (!room.tabs.size) rooms.delete(project.id)
  if (rooms.size && !sweeper) {
    sweeper = setInterval(() => sweepPresence(), 10_000)
    sweeper.unref?.()
  }
  return presenceOf(project.id)
}

/** Tests: forget everyone. */
export function resetPresence() {
  rooms.clear()
  if (sweeper) clearInterval(sweeper)
  sweeper = undefined
}
