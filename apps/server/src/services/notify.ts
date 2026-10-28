// A-8: an email when an export or other long job of yours finishes or fails, for people who turned job emails on
// (Account → Notifications; off by default). The browser side (toasts, browser notifications) runs in the web app
// from the same live job events. Called once per job end from the queue (emitJob).
import { eq } from 'drizzle-orm'
import { JOB_EMAIL_MIN_MS, NOTIFY_JOB_KINDS, normalizeNotifications, type JobKind } from '@producer/core'
import { ctx } from '../context'
import { jobs, projects, users, workspaces } from '../db/schema'
import { log } from '../log'
import { mailEnabled, sendMail } from '../mail'
import { jobMail } from '../mail/messages'

type JobRow = typeof jobs.$inferSelect

const WHAT: Partial<Record<JobKind, string>> = {
  'export.render': 'Your export',
  'ai.produce.script': 'Producer AI’s script',
  'ai.produce.assemble': 'Your Producer AI video',
  'ai.transcribe': 'The transcription',
  'ai.tts': 'The voiceover',
  'media.stabilise': 'Stabilising',
  'media.denoise': 'Denoising',
  'media.bgremove': 'Background removal',
  'media.smooth': 'Smooth slow motion',
  'voicestudio.install': 'Installing VoiceStudio',
}

/** Where the mail's button goes: the export dialog, the Producer project, the editor, or the Library. */
export function jobLink(j: Pick<JobRow, 'kind' | 'projectId'>): string {
  if (!j.projectId) return '/library'
  const p = encodeURIComponent(j.projectId)
  if (j.kind === 'export.render') return `/edit/${p}?export=1`
  if (j.kind.startsWith('ai.produce')) return `/producer/${p}`
  return `/edit/${p}`
}

/** Notice for a job that just ended (done or error). Never throws: a mail that can't go out mustn't touch the job. */
export async function jobEnded(j: JobRow): Promise<boolean> {
  try {
    if (j.status !== 'done' && j.status !== 'error') return false
    if (!(NOTIFY_JOB_KINDS as readonly string[]).includes(j.kind)) return false
    // a draft preview isn't something anyone waits for by mail
    if (j.kind === 'export.render' && (j.input as { preview?: unknown })?.preview) return false
    if (j.updatedAt - j.createdAt < JOB_EMAIL_MIN_MS || !mailEnabled()) return false
    const db = ctx().db
    const u = (await db.select().from(users).where(eq(users.id, j.userId)).limit(1))[0]
    if (!u || !normalizeNotifications(u.notify).emailJobs) return false
    const ws = (await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, j.workspaceId)).limit(1))[0]
    if (!ws) return false
    const project = j.projectId ? (await db.select({ name: projects.name }).from(projects).where(eq(projects.id, j.projectId)).limit(1))[0]?.name : undefined
    const base = (ctx().config.publicUrl ?? '').replace(/\/+$/, '')
    return await sendMail(
      jobMail({
        to: u.email,
        name: u.name,
        space: ws.name,
        what: WHAT[j.kind as JobKind] ?? 'Your job',
        project,
        ok: j.status === 'done',
        error: j.status === 'error' ? (j.error ?? undefined) : undefined,
        url: `${base}${jobLink(j)}`,
      }),
    )
  } catch (err) {
    log.warn('job notice failed', { jobId: j.id, err: err instanceof Error ? err.message : String(err) })
    return false
  }
}
