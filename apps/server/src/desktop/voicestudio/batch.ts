// Batch dubbing follow-up (desktop): VoiceStudio's /batch queue renders one dubbed MP4 per target language. Jobs queued
// from Voice Studio are tracked here (desktop_kv), and a light poller imports each finished language into the space's
// library as a `dub` asset, then forgets the job. Jobs that fail or are cancelled are just forgotten.
import { kvGet, kvSet } from '../db'
import { enqueue } from '../../jobs/queue'
import { log } from '../../log'
import { vs } from './client'
import { voiceStudio } from './runtime'

export interface TrackedBatch {
  jobId: string
  workspaceId: string
  userId: string
  name: string
  langs: string[]
  trackedAt: number
}

const KEY = 'vsBatchTracked'
const POLL_MS = 15_000

export async function trackedBatches(): Promise<TrackedBatch[]> {
  return (await kvGet<TrackedBatch[]>(KEY)) ?? []
}

let lock: Promise<unknown> = Promise.resolve()

/** Change the tracked list: one change at a time, each on the list as it is then (never on a copy read earlier). */
function changeTracked(fn: (list: TrackedBatch[]) => TrackedBatch[]): Promise<void> {
  const run = lock.then(async () => kvSet(KEY, fn(await trackedBatches())))
  lock = run.catch(() => undefined)
  return run
}

export async function trackBatch(t: Omit<TrackedBatch, 'trackedAt'>) {
  await changeTracked((list) => [...list.filter((x) => x.jobId !== t.jobId), { ...t, trackedAt: Date.now() }])
  startBatchWatcher()
}

export async function untrackBatch(jobId: string) {
  await changeTracked((list) => list.filter((x) => x.jobId !== jobId))
}

interface VsBatchJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  outputs?: Record<string, string>
  filename?: string
}

/**
 * One pass: import finished jobs, drop failed/cancelled/vanished ones. Jobs tracked or untracked while it runs stay
 * as they were left (only what this pass finished with is taken off). Exported for tests.
 */
export function pollBatches(): Promise<number> {
  // one pass at a time: two at once would import a finished job twice
  polling ??= pollOnce().finally(() => (polling = undefined))
  return polling
}

let polling: Promise<number> | undefined

async function pollOnce(): Promise<number> {
  const list = await trackedBatches()
  if (!list.length || voiceStudio.status().state !== 'running') return 0
  let imported = 0
  const done = new Set<string>()
  for (const t of list) {
    let job: VsBatchJob | undefined
    try {
      const res = await vs(`/batch/jobs/${encodeURIComponent(t.jobId)}`, { timeoutMs: 15_000 })
      if (res.status === 404) {
        done.add(t.jobId) // gone (VoiceStudio restarted without it): forget
        continue
      }
      if (!res.ok) continue
      job = (await res.json()) as VsBatchJob
    } catch {
      continue
    }
    if (job.status === 'queued' || job.status === 'running') continue
    // untracked meanwhile (cancelled from Voice Studio): nothing to import
    if (!(await trackedBatches()).some((x) => x.jobId === t.jobId)) continue
    done.add(t.jobId)
    if (job.status === 'done') {
      for (const lang of Object.keys(job.outputs ?? {})) {
        await enqueue(
          'voicestudio.task',
          { op: 'import', workspaceId: t.workspaceId, source: `/batch/download/${encodeURIComponent(t.jobId)}/${encodeURIComponent(lang)}`, name: `${t.name} — ${lang}`, kind: 'video', ext: '.mp4', origin: 'dub' },
          { workspaceId: t.workspaceId, userId: t.userId, message: `Importing ${t.name} (${lang})` },
        )
        imported++
      }
      log.info('voicestudio: batch job imported', { jobId: t.jobId, langs: Object.keys(job.outputs ?? {}) })
    }
  }
  if (done.size) await changeTracked((cur) => cur.filter((x) => !done.has(x.jobId)))
  return imported
}

let timer: NodeJS.Timeout | undefined

/** Poll while anything is tracked (started at boot and whenever a job is tracked). */
export function startBatchWatcher() {
  if (timer) return
  timer = setInterval(() => {
    void pollBatches()
      .then(async () => {
        if (!(await trackedBatches()).length && timer) {
          clearInterval(timer)
          timer = undefined
        }
      })
      .catch((e) => log.warn('voicestudio: batch poll failed', { err: String(e) }))
  }, POLL_MS)
  timer.unref()
}

export function stopBatchWatcher() {
  if (timer) clearInterval(timer)
  timer = undefined
}
