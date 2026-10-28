// Client for usage, the queue and the job history (contract: packages/core/src/usage.ts). Kept beside lib/api.ts so
// the two change independently.
import type { Job, Page, QueueInfo, UsageSummary } from '@producer/core'
import { HttpError, noteStatus } from './api'

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  noteStatus(path, res.status)
  if (!res.ok) {
    let err = { error: res.statusText } as { error: string; code?: never; details?: unknown }
    try {
      err = await res.json()
    } catch {
      /* not JSON */
    }
    throw new HttpError(res.status, err)
  }
  return (await res.json()) as T
}

const enc = encodeURIComponent

export type HistoryStatus = 'done' | 'error' | 'cancelled'

export const usageApi = {
  usage: (workspaceId: string, days = 30) => call<UsageSummary>('GET', `/usage?workspaceId=${enc(workspaceId)}&days=${days}`),
  setBuiltinAi: (workspaceId: string, enabled: boolean) => call<{ enabled: boolean }>('PUT', '/usage/builtin-ai', { workspaceId, enabled }),
  queue: (workspaceId: string) => call<{ jobs: Record<string, QueueInfo> }>('GET', `/jobs/queue?workspaceId=${enc(workspaceId)}`),
  history: (workspaceId: string, opts: { status?: HistoryStatus; cursor?: string } = {}) =>
    call<Page<Job>>('GET', `/jobs/history?workspaceId=${enc(workspaceId)}${opts.status ? `&status=${opts.status}` : ''}${opts.cursor ? `&cursor=${enc(opts.cursor)}` : ''}&limit=50`),
  retryJob: (id: string) => call<Job>('POST', `/jobs/${enc(id)}/retry`),
}
