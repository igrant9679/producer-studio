// In-process pub/sub keyed by workspace, bridged across processes with Postgres LISTEN/NOTIFY when the
// database is postgres-js (separate api + worker services). NOTIFY payloads carry only a reference; the
// receiving process reloads the entity so large records (waveforms, transcripts) never hit the 8 KB limit.
import { EventEmitter } from 'node:events'
import type { Database } from './db'
import { log } from './log'

export type EventName = 'job' | 'asset' | 'project' | 'sync'

export interface BusEvent {
  workspaceId: string
  event: EventName
  data: unknown
}

type Loader = (event: EventName, id: string) => Promise<{ workspaceId: string; data: unknown } | null>

const CHANNEL = 'ps_events'

export class EventBus {
  private em = new EventEmitter()
  private loader?: Loader

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
      const msg = JSON.parse(payload) as { o: string; e: EventName; id: string; ws: string; d?: unknown }
      if (msg.o === this.instanceId) return
      let data = msg.d
      if (data === undefined && this.loader) {
        const loaded = await this.loader(msg.e, msg.id)
        if (!loaded) return
        data = loaded.data
      }
      if (data !== undefined) this.em.emit(msg.ws, { workspaceId: msg.ws, event: msg.e, data } satisfies BusEvent)
    } catch (err) {
      log.warn('bad event notification', { err })
    }
  }

  /** Publish to local subscribers and (on Postgres) to other processes. */
  publish(workspaceId: string, event: EventName, data: unknown, ref?: { id: string; inline?: unknown }) {
    this.em.emit(workspaceId, { workspaceId, event, data } satisfies BusEvent)
    this.em.emit('*', { workspaceId, event, data } satisfies BusEvent)
    if (this.database.driver === 'postgres' && ref) {
      const payload = JSON.stringify({ o: this.instanceId, e: event, id: ref.id, ws: workspaceId, d: ref.inline })
      void this.database.notify(CHANNEL, payload.length < 7900 ? payload : JSON.stringify({ o: this.instanceId, e: event, id: ref.id, ws: workspaceId })).catch((err) => log.warn('notify failed', { err }))
    }
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
