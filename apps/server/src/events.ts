// In-process pub/sub keyed by workspace, bridged across processes with Postgres LISTEN/NOTIFY when the
// database is postgres-js (separate api + worker services). NOTIFY payloads carry only a reference; the
// receiving process reloads the entity so large records (waveforms, transcripts) never hit the 8 KB limit.
//
// Every event delivered here gets an id (`<process>.<n>`) and the last few minutes of each workspace's events are
// kept, so a live-update stream that reconnects with Last-Event-ID gets what it missed (P-16); when they can't be
// told (another process answered, or it was away too long) the stream says `resync` and the screen reloads instead.
import { EventEmitter } from 'node:events'
import type { Database } from './db'
import { log } from './log'

export type EventName = 'job' | 'asset' | 'project' | 'sync' | 'workspace' | 'presence' | 'comment'

export interface BusEvent {
  workspaceId: string
  event: EventName
  data: unknown
  /** `<process>.<n>`: the live-update stream's event id. */
  id?: string
}

/**
 * How an event travels. `id` names the entity for other processes (they reload it by reference unless `inline` is
 * the data to send as is); without it the event stays in this process. `replay: false` leaves it out of the replay
 * buffer (momentary news, such as who has a project open, that is stale by the time anyone reconnects).
 */
export interface PublishOptions {
  id?: string
  inline?: unknown
  replay?: boolean
}

type Loader = (event: EventName, id: string) => Promise<{ workspaceId: string; data: unknown } | null>

const CHANNEL = 'ps_events'
/** Replay buffer per workspace: this many events, for this long. */
export const REPLAY_MAX_EVENTS = 500
export const REPLAY_MAX_MS = 10 * 60_000

interface Kept {
  seq: number
  at: number
  ev: BusEvent
}

export class EventBus {
  private em = new EventEmitter()
  private loader?: Loader
  private seq = 0
  private sweptAt = 0
  private recent = new Map<string, { events: Kept[]; droppedThrough: number }>()

  constructor(
    private database: Database,
    private instanceId: string,
  ) {
    this.em.setMaxListeners(0)
  }

  /** Set by the app: reload an entity by reference for cross-process events. */
  setLoader(l: Loader) {
    this.loader = l
  }

  async start() {
    if (this.database.driver !== 'postgres') return
    await this.database.listen(CHANNEL, (payload) => {
      void this.onNotify(payload)
    })
  }

  private async onNotify(payload: string) {
    try {
      const msg = JSON.parse(payload) as { o: string; e: EventName | 'access'; id: string; ws: string; d?: unknown }
      if (msg.o === this.instanceId) return
      if (msg.e === 'access') return void this.em.emit(`user:${msg.id}`)
      let data = msg.d
      if (data === undefined && this.loader) {
        const loaded = await this.loader(msg.e, msg.id)
        if (!loaded) return
        data = loaded.data
      }
      if (data !== undefined) this.deliver({ workspaceId: msg.ws, event: msg.e, data }, true, true)
    } catch (err) {
      log.warn('bad event notification', { err })
    }
  }

  /** Stamp an id, keep it for replay, hand it to this process's subscribers (onAny hears only local ones). */
  private deliver(e: BusEvent, replay: boolean, remote = false) {
    const seq = ++this.seq
    const ev: BusEvent = { ...e, id: `${this.instanceId}.${seq}` }
    if (replay) {
      const now = Date.now()
      let r = this.recent.get(e.workspaceId)
      if (!r) this.recent.set(e.workspaceId, (r = { events: [], droppedThrough: 0 }))
      r.events.push({ seq, at: now, ev })
      while (r.events.length > REPLAY_MAX_EVENTS || (r.events.length && now - r.events[0].at > REPLAY_MAX_MS)) r.droppedThrough = r.events.shift()!.seq
      // quiet workspaces let go of their old events too (what was dropped is remembered, so a resume still knows)
      if (now - this.sweptAt > REPLAY_MAX_MS / 10) {
        this.sweptAt = now
        for (const k of this.recent.values()) while (k.events.length && now - k.events[0].at > REPLAY_MAX_MS) k.droppedThrough = k.events.shift()!.seq
      }
    }
    this.em.emit(e.workspaceId, ev)
    if (!remote) this.em.emit('*', ev)
  }

  /**
   * Publish to local subscribers and (on Postgres, with `opts.id`) to other processes. The one way every event is
   * sent: jobs, assets, projects, sync, workspaces, and whatever else a screen should hear about live.
   */
  publish(workspaceId: string, event: EventName, data: unknown, opts?: PublishOptions) {
    this.deliver({ workspaceId, event, data }, opts?.replay !== false)
    if (this.database.driver === 'postgres' && opts?.id) {
      const payload = JSON.stringify({ o: this.instanceId, e: event, id: opts.id, ws: workspaceId, d: opts.inline })
      void this.database.notify(CHANNEL, payload.length < 7900 ? payload : JSON.stringify({ o: this.instanceId, e: event, id: opts.id, ws: workspaceId })).catch((err) => log.warn('notify failed', { err }))
    }
  }

  /** Where the stream stands now: an id to resume from when nothing has been sent yet. */
  cursor(): string {
    return `${this.instanceId}.${this.seq}`
  }

  /**
   * A workspace's events after `lastId`, oldest first, or null when they can't be told: the id is another
   * process's (or an earlier run's), or events after it have already left the buffer.
   */
  replay(workspaceId: string, lastId: string): BusEvent[] | null {
    const dot = lastId.lastIndexOf('.')
    const seq = Number(lastId.slice(dot + 1))
    if (dot <= 0 || lastId.slice(0, dot) !== this.instanceId || !Number.isInteger(seq) || seq < 0 || seq > this.seq) return null
    const r = this.recent.get(workspaceId)
    if (!r) return []
    const now = Date.now()
    while (r.events.length && now - r.events[0].at > REPLAY_MAX_MS) r.droppedThrough = r.events.shift()!.seq
    if (seq < r.droppedThrough) return null
    return r.events.filter((k) => k.seq > seq).map((k) => k.ev)
  }

  /**
   * Someone's access may have changed (signed out, a device revoked): their open streams re-check now, in every
   * process. Membership changes don't need this; they arrive as `workspace` events.
   */
  accessChanged(userId: string) {
    this.em.emit(`user:${userId}`)
    if (this.database.driver === 'postgres') void this.database.notify(CHANNEL, JSON.stringify({ o: this.instanceId, e: 'access', id: userId, ws: '' })).catch((err) => log.warn('notify failed', { err }))
  }

  onAccessChanged(userId: string, fn: () => void): () => void {
    this.em.on(`user:${userId}`, fn)
    return () => this.em.off(`user:${userId}`, fn)
  }

  /** Every local event regardless of workspace (desktop sync schedules a push after local saves). */
  onAny(fn: (e: BusEvent) => void): () => void {
    this.em.on('*', fn)
    return () => this.em.off('*', fn)
  }

  subscribe(workspaceId: string, fn: (e: BusEvent) => void): () => void {
    this.em.on(workspaceId, fn)
    return () => this.em.off(workspaceId, fn)
  }
}
