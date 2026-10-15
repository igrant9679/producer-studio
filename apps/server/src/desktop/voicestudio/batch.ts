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

export async function trackBatch(t: Omit<TrackedBatch, 'trackedAt'>) {
  const list = (await trackedBatches()).filter((x) => x.jobId !== t.jobId)
  list.push({ ...t, trackedAt: Date.now() })
  await kvSet(KEY, list)
  startBatchWatcher()
}

export async function untrackBatch(jobId: string) {
  await kvSet(KEY, (await trackedBatches()).filter((x) => x.jobId !== jobId))
}

interface VsBatchJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  outputs?: Record<string, string>
  filename?: string
}

/** One pass: import finished jobs, drop failed/cancelled/vanished ones. Exported for tests. */
export async function pollBatches(): Promise<number> {
  const list = await trackedBatches()
  if (!list.length || voiceStudio.status().state !== 'running') return 0
  let imported = 0
  const keep: TrackedBatch[] = []
  for (const t of list) {
    let job: VsBatchJob | undefined
    try {
      const res = await vs(`/batch/jobs/${encodeURIComponent(t.jobId)}`, { timeoutMs: 15_000 })
      if (res.status === 404) continue // gone (VoiceStudio restarted without it): forget
      if (!res.ok) {
        keep.push(t)
        continue
      }
      job = (await res.json()) as VsBatchJob
    } catch {
      keep.push(t)
      continue
    }
    if (job.status === 'queued' || job.status === 'running') {
      keep.push(t)
      continue
    }
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
  await kvSet(KEY, keep)
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
