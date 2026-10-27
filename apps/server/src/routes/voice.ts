// VoiceStudio voice profiles (synced metadata, both editions) and the cloud → desktop relay for generating speech with
// them. The engine itself only runs on the desktop edition (desktop/voicestudio/*); see docs/voicestudio.md.
import { Hono } from 'hono'
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import * as z from 'zod/v4'
import { profileVoiceId, type Voice, type VoiceProfile } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { assets, devices, jobs, memberships, voiceProfiles } from '../db/schema'
import { assetRecord, jobDto } from '../dto'
import { HttpError, body, forbidden, notFound, requireRole } from '../http'
import { emitJob, failJob, finishJob, getJob, updateProgress } from '../jobs/queue'

export type VoiceProfileRow = typeof voiceProfiles.$inferSelect

/** A desktop counts as online when it polled the relay recently. */
export const DEVICE_ONLINE_MS = 2 * 60_000

export function voiceProfileDto(r: VoiceProfileRow): VoiceProfile {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    name: r.name,
    kind: r.kind === 'design' ? 'design' : 'clone',
    engine: r.engine,
    language: r.language ?? undefined,
    gender: r.gender ?? undefined,
    description: r.description ?? undefined,
    consent: r.consent,
    deviceId: r.deviceId ?? undefined,
    local: ctx().config.mode === 'desktop' && !!r.vsProfileId,
    ...(ctx().config.mode === 'desktop' && r.vsProfileId ? { vsProfileId: r.vsProfileId } : {}),
    sampleAssetId: r.sampleAssetId ?? undefined,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

export async function loadVoiceProfile(id: string): Promise<VoiceProfileRow> {
  const row = (await ctx().db.select().from(voiceProfiles).where(eq(voiceProfiles.id, id)).limit(1))[0]
  if (!row) throw notFound('Voice not found')
  return row
}

/** Profile voices for the voice pickers, with availability on this replica. */
export async function profileVoices(userId: string, workspaceId?: string): Promise<Voice[]> {
  const db = ctx().db
  const mine = (await db.select({ ws: memberships.workspaceId }).from(memberships).where(eq(memberships.userId, userId))).map((m) => m.ws)
  const scope = workspaceId ? mine.filter((w) => w === workspaceId) : mine
  if (!scope.length) return []
  const rows = await db.select().from(voiceProfiles).where(inArray(voiceProfiles.workspaceId, scope)).orderBy(asc(voiceProfiles.createdAt))
  const desktop = ctx().config.mode === 'desktop'
  let running = false
  if (desktop && rows.some((r) => r.vsProfileId)) {
    const { voiceStudio } = await import('../desktop/voicestudio/runtime')
    running = voiceStudio.status().state === 'running'
  }
  const devIds = [...new Set(rows.map((r) => r.deviceId).filter((d): d is string => !!d))]
  const devs = !desktop && devIds.length ? await db.select().from(devices).where(inArray(devices.id, devIds)) : []
  const now = Date.now()
  return rows.map((r) => {
    const base: Voice = { id: profileVoiceId(r.id), name: r.name, lang: r.language || 'Multilingual', gender: r.gender || 'custom', style: r.kind === 'design' ? 'Designed voice' : 'Cloned voice', source: r.kind === 'design' ? 'design' : 'clone', engine: r.engine }
    if (desktop) {
      if (!r.vsProfileId) return { ...base, available: false, detail: 'Created on another computer' }
      return { ...base, available: running, detail: running ? 'VoiceStudio on this computer' : 'Start VoiceStudio to use this voice' }
    }
    const d = devs.find((x) => x.id === r.deviceId)
    const online = !!d?.lastSeenAt && now - d.lastSeenAt < DEVICE_ONLINE_MS
    return { ...base, available: online, detail: d ? (online ? `Generated on ${d.name}` : `Open Producer Studio on ${d.name} to use this voice`) : 'The desktop that holds this voice is no longer linked' }
  })
}

/** Desktop: push voice edits to the cloud soon (the sync engine only watches project/asset events). */
export async function voicesChangedLocally() {
  if (ctx().config.mode !== 'desktop') return
  const { syncEngine } = await import('../desktop/sync')
  syncEngine.voicesChanged()
  syncEngine.schedule(1000)
}

export const voiceRoutes = new Hono<AppEnv>()

voiceRoutes.get('/profiles', async (c) => {
  const u = requireUser(c)
  const ws = c.req.query('workspaceId')
  if (!ws) throw new HttpError(400, 'invalid', 'workspaceId is required')
  await requireRole(u.id, ws, 'viewer')
  const rows = await ctx().db.select().from(voiceProfiles).where(eq(voiceProfiles.workspaceId, ws)).orderBy(asc(voiceProfiles.createdAt))
  return c.json(rows.map(voiceProfileDto))
})

voiceRoutes.patch('/profiles/:id', async (c) => {
  const u = requireUser(c)
  const row = await loadVoiceProfile(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().max(2000).optional(), gender: z.string().max(20).optional(), language: z.string().max(60).optional() }))
  const [upd] = await ctx()
    .db.update(voiceProfiles)
    .set({ ...b, updatedAt: Date.now() })
    .where(eq(voiceProfiles.id, row.id))
    .returning()
  await voicesChangedLocally()
  return c.json(voiceProfileDto(upd))
})

voiceRoutes.delete('/profiles/:id', async (c) => {
  const u = requireUser(c)
  const row = await loadVoiceProfile(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  if (ctx().config.mode === 'desktop' && row.vsProfileId) {
    const { deleteVsProfile } = await import('../desktop/voicestudio/profiles')
    await deleteVsProfile(row.vsProfileId)
  }
  await ctx().db.delete(voiceProfiles).where(eq(voiceProfiles.id, row.id))
  await voicesChangedLocally()
  return c.json({ ok: true })
})

/** Desktop push (device token): create or update a profile's synced metadata. The pushing device owns new rows. */
const PushSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['clone', 'design']),
  engine: z.string().max(80),
  language: z.string().max(60).optional(),
  gender: z.string().max(20).optional(),
  description: z.string().max(2000).optional(),
  consent: z.object({ statement: z.string().max(2000), attestedBy: z.string().max(80), attestedAt: z.number(), speaker: z.string().max(120).optional() }),
  createdAt: z.number(),
  updatedAt: z.number(),
})

voiceRoutes.put('/profiles/:id', async (c) => {
  const { userId, deviceId } = requireDevice(c)
  const id = c.req.param('id')
  if (!/^vp_[A-Za-z0-9_-]{4,60}$/.test(id)) throw new HttpError(400, 'invalid', 'Bad voice id')
  const b = await body(c, PushSchema)
  await requireRole(userId, b.workspaceId, 'editor')
  const cur = (await ctx().db.select().from(voiceProfiles).where(eq(voiceProfiles.id, id)).limit(1))[0]
  if (cur && cur.workspaceId !== b.workspaceId) throw new HttpError(409, 'conflict', 'That voice belongs to another space')
  // only the computer that made the voice (or the person who made it) pushes changes to it
  if (cur && cur.deviceId !== deviceId && cur.createdBy !== userId) throw new HttpError(403, 'forbidden', 'Only the computer that made this voice can change it')
  // timestamps from a device's clock can't be in the future, or a copy could pin itself as "newest" for good
  const now = Date.now()
  const updatedAt = Math.min(b.updatedAt, now)
  if (cur && cur.updatedAt >= updatedAt) return c.json(voiceProfileDto(cur)) // cloud copy is as new or newer
  const values = { workspaceId: b.workspaceId, name: b.name, kind: b.kind, engine: b.engine, language: b.language ?? null, gender: b.gender ?? null, description: b.description ?? null, updatedAt }
  // the consent record is written once, when the voice is created, and never replaced afterwards
  const [row] = cur
    ? await ctx().db.update(voiceProfiles).set(values).where(eq(voiceProfiles.id, id)).returning()
    : await ctx()
        .db.insert(voiceProfiles)
        .values({ id, ...values, consent: { ...b.consent, attestedAt: Math.min(b.consent.attestedAt, now) }, deviceId, createdBy: userId, createdAt: Math.min(b.createdAt, now) })
        .returning()
  return c.json(voiceProfileDto(row))
})

// ---------------- cloud → desktop relay ----------------
// The cloud can't run VoiceStudio. TTS with a profile voice enqueues a `voice.relay` job (never claimed by the cloud
// worker); the desktop owning the voice polls /relay/claim with its device token, generates locally, pushes the asset
// (same id) through sync, then reports /done with the asset id.

export interface RelayInput {
  profileId: string
  deviceId: string
  text: string
  speed?: number
  name?: string
  language?: string
}

function requireDevice(c: Parameters<typeof requireUser>[0]): { userId: string; deviceId: string } {
  const u = requireUser(c)
  const deviceId = c.get('deviceId')
  if (!deviceId) throw forbidden('Only a linked desktop can do this')
  return { userId: u.id, deviceId }
}

async function relayJob(id: string, deviceId: string) {
  const j = await getJob(id)
  if (!j || j.kind !== 'voice.relay') throw notFound('Job not found')
  if ((j.input as unknown as RelayInput).deviceId !== deviceId) throw forbidden()
  return j
}

voiceRoutes.get('/relay/claim', async (c) => {
  const { deviceId } = requireDevice(c)
  const now = Date.now()
  const rows = await ctx()
    .db.update(jobs)
    .set({ status: 'running', lockedBy: `device:${deviceId}`, lockedAt: now, updatedAt: now, attempts: sql`${jobs.attempts} + 1`, message: 'Generating on your desktop' })
    .where(
      eq(
        jobs.id,
        sql`(SELECT id FROM jobs WHERE status = 'queued' AND kind = 'voice.relay' AND input->>'deviceId' = ${deviceId} ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`,
      ),
    )
    .returning()
  const j = rows[0]
  if (!j) return c.json({ job: null })
  emitJob(j)
  return c.json({ job: { ...jobDto(j), input: j.input as unknown as RelayInput, userId: j.userId } })
})

voiceRoutes.post('/relay/:id/progress', async (c) => {
  const { deviceId } = requireDevice(c)
  const j = await relayJob(c.req.param('id'), deviceId)
  const b = await body(c, z.object({ progress: z.number().min(-1).max(1), message: z.string().max(200).optional() }))
  // also the desktop's heartbeat (its lease, see RELAY_LEASE_MS); a relay that ended here tells it to stop
  const row = await updateProgress(j.id, b.progress, b.message, `device:${deviceId}`)
  return c.json({ ok: true, cancelled: !row || row.cancelRequested })
})

voiceRoutes.post('/relay/:id/done', async (c) => {
  const { deviceId } = requireDevice(c)
  const j = await relayJob(c.req.param('id'), deviceId)
  const b = await body(c, z.object({ assetId: z.string().min(1).max(80) }))
  const a = (await ctx().db.select().from(assets).where(and(eq(assets.id, b.assetId), eq(assets.workspaceId, j.workspaceId))).limit(1))[0]
  if (!a) throw new HttpError(409, 'conflict', 'Upload the asset before completing the job')
  const row = await finishJob(j.id, { asset: assetRecord(a), duration: a.meta?.duration ?? 0 })
  return c.json(row ? jobDto(row) : { ok: true })
})

voiceRoutes.post('/relay/:id/fail', async (c) => {
  const { deviceId } = requireDevice(c)
  const j = await relayJob(c.req.param('id'), deviceId)
  const b = await body(c, z.object({ error: z.string().max(4000) }))
  const row = await failJob(j.id, b.error)
  return c.json(row ? jobDto(row) : { ok: true })
})

/**
 * Relayed voices have their own lease, not the cloud worker's 90 s: the desktop heartbeats every 15 s while it
 * generates (desktop/sync.ts), so one quiet for this long has gone away. It ends with a reason rather than being
 * requeued, which would have the desktop generate the same voice again.
 */
export const RELAY_LEASE_MS = 2 * 60_000
/** A queued relay nobody picks up ends: after this long in all, or sooner once its desktop has been offline a while. */
export const RELAY_QUEUED_MS = 15 * 60_000

const RELAY_LOST = "The desktop making this voice stopped responding. Check it's online with Producer Studio open, then try again."

/** Relays whose desktop went away mid-voice, or that nobody picked up. Returns how many ended. */
export async function recoverRelays(now = Date.now()): Promise<number> {
  const db = ctx().db
  const ended: Array<typeof jobs.$inferSelect> = []
  const lost = await db
    .update(jobs)
    .set({ status: 'error', error: RELAY_LOST, message: 'Failed', lockedBy: null, updatedAt: now })
    .where(and(eq(jobs.kind, 'voice.relay'), eq(jobs.status, 'running'), lt(jobs.lockedAt, now - RELAY_LEASE_MS)))
    .returning()
  ended.push(...lost)
  const waiting = await db
    .select({ id: jobs.id, createdAt: jobs.createdAt, deviceId: sql<string>`${jobs.input}->>'deviceId'` })
    .from(jobs)
    .where(and(eq(jobs.kind, 'voice.relay'), eq(jobs.status, 'queued'), lt(jobs.createdAt, now - DEVICE_ONLINE_MS)))
  if (waiting.length) {
    const devs = new Map((await db.select().from(devices).where(inArray(devices.id, [...new Set(waiting.map((w) => w.deviceId))]))).map((d) => [d.id, d]))
    for (const w of waiting) {
      const d = devs.get(w.deviceId)
      const offline = !d?.lastSeenAt || now - d.lastSeenAt > DEVICE_ONLINE_MS
      if (!offline && w.createdAt > now - RELAY_QUEUED_MS) continue
      const error = offline
        ? `${d ? `“${d.name}”` : 'The desktop that holds this voice'} is offline, so it couldn't make this voice. Open Producer Studio on it, then try again.`
        : "The desktop that holds this voice didn't get to this request in time. Try again."
      const [row] = await db
        .update(jobs)
        .set({ status: 'error', error, message: 'Failed', updatedAt: now })
        .where(and(eq(jobs.id, w.id), eq(jobs.status, 'queued')))
        .returning()
      if (row) ended.push(row)
    }
  }
  ended.forEach(emitJob)
  return ended.length
}
