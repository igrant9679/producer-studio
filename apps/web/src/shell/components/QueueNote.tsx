// Why a queued job hasn't started and when it might (A-9), under the job in the jobs list. Every note on screen shares
// one poll of GET /api/jobs/queue per space (every 10 s while any is shown), so an open list stays current as other
// jobs finish, and a closed one asks for nothing.
import type { Job, QueueInfo } from '@producer/core'
import { useEffect } from 'react'
import { create } from 'zustand'
import { usageApi } from '../../lib/usageApi'
import './queue-note.css'

const POLL_MS = 10_000

const useQueue = create<{ info: Record<string, QueueInfo> }>(() => ({ info: {} }))
const watchers = new Map<string, { n: number; timer?: ReturnType<typeof setInterval> }>()

async function refresh(workspaceId: string) {
  try {
    const r = await usageApi.queue(workspaceId)
    useQueue.setState((s) => ({ info: { ...s.info, ...r.jobs } }))
  } catch {
    /* the note just stays as it was */
  }
}

function watch(workspaceId: string) {
  const w = watchers.get(workspaceId) ?? { n: 0 }
  w.n++
  if (w.n === 1) {
    void refresh(workspaceId)
    w.timer = setInterval(() => void refresh(workspaceId), POLL_MS)
  }
  watchers.set(workspaceId, w)
  return () => {
    w.n--
    if (w.n <= 0) {
      clearInterval(w.timer)
      watchers.delete(workspaceId)
    }
  }
}

/** "about 4 min", "under a minute", "about 2 h". */
export function waitWords(ms: number): string {
  if (ms < 60_000) return 'under a minute'
  const m = Math.round(ms / 60_000)
  return m < 90 ? `about ${m} min` : `about ${Math.round(m / 6) / 10} h`
}

/** The note in words: the reason, then the estimated wait. */
export function queueWords(q: QueueInfo): string {
  if (q.reason === 'next' || q.reason === 'desktop') return q.detail
  return `${q.detail} · ${q.waitMs === null ? 'wait unknown' : `starts in ${waitWords(q.waitMs)}`}`
}

export function QueueNote({ job }: { job: Job }) {
  const info = useQueue((s) => s.info[job.id])
  useEffect(() => watch(job.workspaceId), [job.workspaceId])
  if (!info) return null
  return <div className="ps-job-queue">{queueWords(info)}</div>
}

/** Tests: forget what was fetched. */
export function resetQueueNotes() {
  useQueue.setState({ info: {} })
  for (const w of watchers.values()) clearInterval(w.timer)
  watchers.clear()
}
