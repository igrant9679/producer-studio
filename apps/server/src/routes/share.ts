import { Hono, type Context } from 'hono'
import crypto from 'node:crypto'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import * as z from 'zod/v4'
import { ASPECT_RATIOS, SHARE_PASSWORD_MAX, SHARE_PASSWORD_MIN, type ShareLinkDetails, type ShareLinkSettings, type SharedPage } from '@producer/core'
import { type AppEnv, clientIp, hashPassword, requireUser, verifyPassword } from '../auth'
import { ctx } from '../context'
import { assets, exportsTable, jobs, projects, shareLinks, users } from '../db/schema'
import { previewKey } from '../render/export'
import { exportDto, jobDto, projectSummary } from '../dto'
import { HttpError, body, invalid, notFound, requireRole } from '../http'
import { randomToken } from '../ids'
import { enqueue } from '../jobs/queue'
import { assertQueueRoom, hit } from '../limits'
import { serveObject } from '../media/serve'
import { recordActivity } from '../services/activity'
import { loadAsset } from '../services/assets'
import { addComment, announceComment, commentDtos, NewCommentSchema, projectComments } from '../services/comments'
import { loadProjectRow } from '../services/projects'
import { variantTarget } from './assets'

const ExportSchema = z.object({
  resolution: z.enum(['720p', '1080p', '1440p', '4k']).default('1080p'),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(30),
  quality: z.enum(['draft', 'standard', 'high']).default('standard'),
  format: z.enum(['mp4', 'webm', 'gif', 'mp3', 'wav']).default('mp4'),
  name: z.string().max(200).optional(),
  loudness: z.enum(['off', 'youtube', 'podcast', 'broadcast']).optional(),
  range: z
    .object({ from: z.number().min(0).max(1e6), to: z.number().min(0).max(1e6) })
    .refine((r) => r.to - r.from >= 0.1, 'The range must be at least 0.1 s long')
    .optional(),
  aspect: z.enum(ASPECT_RATIOS.map((a) => a.id) as [string, ...string[]]).optional(),
  captions: z.enum(['burn', 'sidecar', 'none']).optional(),
  captionFormat: z.enum(['srt', 'vtt']).optional(),
  captionTrackId: z.string().max(100).optional(),
  coverAt: z.number().min(0).max(1e6).optional(),
  preview: z.boolean().optional(),
})

/** Mounted at /api/projects (export + share sub-routes). */
export const projectExportRoutes = new Hono<AppEnv>()

projectExportRoutes.post('/:id/export', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, ExportSchema)
  if (row.duration <= 0) throw new HttpError(400, 'invalid', 'The project is empty — add something to the timeline first')
  if (b.range && b.range.from >= row.duration) throw new HttpError(400, 'invalid', 'That range starts after the end of the video')
  await assertQueueRoom(row.workspaceId)
  const j = await enqueue('export.render', { ...b, projectId: row.id }, { workspaceId: row.workspaceId, userId: u.id, projectId: row.id, message: b.preview ? 'Waiting to render the draft' : 'Waiting to render' })
  return c.json(jobDto(j))
})

/** The latest draft preview (export with `preview`): only that project's, only while it is the latest. */
projectExportRoutes.on(['GET', 'HEAD'], '/:id/previews/:jobId', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  const job = (await ctx().db.select().from(jobs).where(eq(jobs.id, c.req.param('jobId'))).limit(1))[0]
  if (!job || job.projectId !== row.id || job.kind !== 'export.render' || job.status !== 'done') throw notFound('This draft is not available')
  return serveObject(c, { key: previewKey(row.workspaceId, row.id, job.id), contentType: 'video/mp4', filename: `${row.name} draft.mp4` }, { cache: 'private, max-age=300' })
})

const shareUrl = (token: string) => `${ctx().config.publicUrl ?? ''}/r/${token}`

type ShareRow = typeof shareLinks.$inferSelect

const SettingsSchema = z.object({
  expiresAt: z.number().min(0).max(4e12).nullable().optional(),
  password: z.string().min(SHARE_PASSWORD_MIN, `A password needs at least ${SHARE_PASSWORD_MIN} characters`).max(SHARE_PASSWORD_MAX).nullable().optional(),
  allowDownload: z.boolean().optional(),
  allowComments: z.boolean().optional(),
})

/** The links with their project, export and creator names (A-16). */
async function linkDetails(rows: ShareRow[], now = Date.now()): Promise<ShareLinkDetails[]> {
  const db = ctx().db
  const live = rows.filter((r) => r.exportId)
  if (!live.length) return []
  const ps = await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, [...new Set(live.map((r) => r.projectId))]))
  const exs = await db.select({ id: exportsTable.id, name: exportsTable.name }).from(exportsTable).where(inArray(exportsTable.id, live.map((r) => r.exportId!)))
  const us = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(live.map((r) => r.createdBy))]))
  const pName = new Map(ps.map((p) => [p.id, p.name]))
  const eName = new Map(exs.map((e) => [e.id, e.name]))
  const uName = new Map(us.map((u) => [u.id, u.name]))
  return live.map((r) => ({
    token: r.token,
    url: shareUrl(r.token),
    exportId: r.exportId!,
    createdAt: r.createdAt,
    projectId: r.projectId,
    projectName: pName.get(r.projectId) ?? '',
    ...(eName.has(r.exportId!) ? { exportName: eName.get(r.exportId!) } : {}),
    createdBy: { id: r.createdBy, name: uName.get(r.createdBy) ?? 'Someone' },
    views: r.views,
    ...(r.lastViewedAt ? { lastViewedAt: r.lastViewedAt } : {}),
    expiresAt: r.expiresAt ?? null,
    expired: r.expiresAt != null && r.expiresAt <= now,
    hasPassword: !!r.passwordHash,
    allowDownload: r.allowDownload,
    allowComments: r.allowComments,
  }))
}

/** The columns a settings change writes, and the words for the activity feed. */
async function settingsPatch(b: ShareLinkSettings): Promise<{ set: Partial<ShareRow>; changes: string[] }> {
  const set: Partial<ShareRow> = {}
  const changes: string[] = []
  if (b.expiresAt !== undefined) {
    set.expiresAt = b.expiresAt
    changes.push(b.expiresAt === null ? 'no expiry' : 'expiry set')
  }
  if (b.password !== undefined) {
    set.passwordHash = b.password === null ? null : await hashPassword(b.password)
    changes.push(b.password === null ? 'password removed' : 'password set')
  }
  if (b.allowDownload !== undefined) {
    set.allowDownload = b.allowDownload
    changes.push(b.allowDownload ? 'downloads on' : 'downloads off')
  }
  if (b.allowComments !== undefined) {
    set.allowComments = b.allowComments
    changes.push(b.allowComments ? 'comments on' : 'comments off')
  }
  return { set, changes }
}

/**
 * A share link always shows one finished export: the one asked for, else the latest. Sharing the same export again
 * returns its existing link rather than a new one, unless `new` asks for another (other settings for other people).
 * With nothing exported yet there is nothing to share.
 */
projectExportRoutes.post('/:id/share', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'editor')
  const b = await body(c, SettingsSchema.extend({ exportId: z.string().optional(), new: z.boolean().optional() }))
  let exportId: string
  if (b.exportId) {
    const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, b.exportId)).limit(1))[0]
    if (!ex || ex.projectId !== row.id) throw notFound('Export not found')
    exportId = ex.id
  } else {
    const latest = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.projectId, row.id)).orderBy(desc(exportsTable.createdAt)).limit(1))[0]
    if (!latest) throw new HttpError(409, 'conflict', 'Export the video first: a share link shows a finished export.')
    exportId = latest.id
  }
  if (!b.new) {
    const existing = (await ctx().db.select().from(shareLinks).where(and(eq(shareLinks.projectId, row.id), eq(shareLinks.exportId, exportId))).orderBy(shareLinks.createdAt).limit(1))[0]
    if (existing) return c.json((await linkDetails([existing]))[0])
  }
  const { set } = await settingsPatch(b)
  const link: ShareRow = { token: randomToken(18), projectId: row.id, exportId, createdBy: u.id, createdAt: Date.now(), expiresAt: null, passwordHash: null, allowDownload: true, allowComments: false, views: 0, lastViewedAt: null, ...set }
  await ctx().db.insert(shareLinks).values(link)
  await recordActivity({ workspaceId: row.workspaceId, projectId: row.id, actorId: u.id, kind: 'share.created', data: { project: row.name } })
  return c.json((await linkDetails([link]))[0])
})

projectExportRoutes.get('/:id/shares', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('id'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  const rows = await ctx().db.select().from(shareLinks).where(eq(shareLinks.projectId, row.id)).orderBy(desc(shareLinks.createdAt))
  return c.json(await linkDetails(rows))
})

/** Mounted at /api/workspaces: every project's links in a space (the Share links page). */
export const workspaceShareRoutes = new Hono<AppEnv>()

workspaceShareRoutes.get('/:id/shares', async (c) => {
  const u = requireUser(c)
  const wsId = c.req.param('id')
  await requireRole(u.id, wsId, 'viewer')
  const rows = await ctx()
    .db.select({ link: shareLinks })
    .from(shareLinks)
    .innerJoin(projects, eq(projects.id, shareLinks.projectId))
    .where(and(eq(projects.workspaceId, wsId), isNull(projects.trashedAt)))
    .orderBy(desc(shareLinks.createdAt))
    .limit(500)
  return c.json(await linkDetails(rows.map((r) => r.link)))
})

export const exportRoutes = new Hono<AppEnv>()

exportRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const projectId = c.req.query('projectId')
  if (!projectId) throw invalid('projectId is required')
  const row = await loadProjectRow(projectId)
  await requireRole(u.id, row.workspaceId, 'viewer')
  const rows = await ctx().db.select().from(exportsTable).where(eq(exportsTable.projectId, projectId)).orderBy(desc(exportsTable.createdAt)).limit(100)
  // which exports have a sidecar caption file beside them
  const files = rows.length ? await ctx().db.select({ id: assets.id, meta: assets.meta }).from(assets).where(inArray(assets.id, rows.map((r) => r.assetId))) : []
  const withCaptions = new Set(files.filter((f) => f.meta?.captions).map((f) => f.id))
  return c.json(rows.map((r) => exportDto(r, withCaptions.has(r.assetId))))
})

/** An export's sidecar captions (SRT or WebVTT), saved as a file. */
exportRoutes.on(['GET', 'HEAD'], '/:id/captions', async (c) => {
  const u = requireUser(c)
  const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, c.req.param('id'))).limit(1))[0]
  if (!ex) throw notFound('Export not found')
  await requireRole(u.id, ex.workspaceId, 'viewer')
  const a = await loadAsset(ex.assetId)
  const cap = a.meta?.captions
  if (!cap) throw notFound('This export has no caption file')
  return serveObject(c, { key: cap.key, contentType: cap.format === 'srt' ? 'application/x-subrip' : 'text/vtt', filename: `${ex.name}.${cap.format}` }, { cache: 'private, max-age=300' })
})

/** Public share routes (no auth). */
export const shareRoutes = new Hono<AppEnv>()

/** How long an unlocked password-protected link stays unlocked in that browser. */
const KEY_TTL_MS = 12 * 3600_000

/** The key a right password earns: signed with the link's password hash, so a new password locks every old key out. */
function accessKey(link: ShareRow, exp = Date.now() + KEY_TTL_MS): string {
  const sig = crypto.createHmac('sha256', link.passwordHash ?? '').update(`${link.token}|${exp}`).digest('base64url').slice(0, 32)
  return `${exp.toString(36)}.${sig}`
}

function keyValid(link: ShareRow, key: string | undefined): boolean {
  if (!key) return false
  const exp = parseInt(key.split('.')[0] ?? '', 36)
  if (!Number.isFinite(exp) || exp <= Date.now()) return false
  const want = Buffer.from(accessKey(link, exp))
  const got = Buffer.from(key)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

async function loadLink(token: string): Promise<ShareRow> {
  const link = (await ctx().db.select().from(shareLinks).where(eq(shareLinks.token, token)).limit(1))[0]
  if (!link) throw notFound('This link is invalid or has been removed')
  return link
}

/**
 * The link's project and export, if this visitor may see them: the link exists, hasn't expired, and (with a password)
 * carries a key from /unlock as `?k=` or `X-Share-Key`.
 */
async function resolveShare(c: Context) {
  const link = await loadLink(c.req.param('token') ?? '')
  if (link.expiresAt != null && link.expiresAt <= Date.now()) throw new HttpError(410, 'not_found', 'This link has expired. Ask whoever sent it for a new one.')
  if (link.passwordHash && !keyValid(link, c.req.query('k') ?? c.req.header('x-share-key'))) throw new HttpError(401, 'unauthorized', 'This video is protected by a password.', { password: true })
  const project = await loadProjectRow(link.projectId).catch(() => null)
  if (!project || project.trashedAt) throw notFound('This video is no longer available')
  let ex = link.exportId ? (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, link.exportId)).limit(1))[0] : undefined
  if (!ex && !link.exportId) {
    // a link made before links were pinned: pin it to what it shows now, so later drafts never go public through it
    ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.projectId, project.id)).orderBy(desc(exportsTable.createdAt)).limit(1))[0]
    if (ex) await ctx().db.update(shareLinks).set({ exportId: ex.id }).where(and(eq(shareLinks.token, link.token), isNull(shareLinks.exportId)))
  }
  return { link, project, ex }
}

/** Where the shared export starts in the project (an export of a range): visitors' comment times are video times. */
async function exportOffset(ex: { jobId: string | null } | undefined): Promise<number> {
  if (!ex?.jobId) return 0
  const job = (await ctx().db.select({ input: jobs.input }).from(jobs).where(eq(jobs.id, ex.jobId)).limit(1))[0]
  const from = (job?.input as { range?: { from?: number } } | undefined)?.range?.from
  return typeof from === 'number' && from > 0 ? from : 0
}

shareRoutes.get('/:token', async (c) => {
  const { link, project, ex } = await resolveShare(c)
  const s = projectSummary(project)
  const base = `/api/share/${encodeURIComponent(c.req.param('token'))}`
  const key = c.req.query('k') ?? c.req.header('x-share-key')
  const k = link.passwordHash && key ? `?k=${encodeURIComponent(key)}` : ''
  const poster = ex ? (await loadAsset(ex.assetId).catch(() => null))?.thumbKey : undefined
  await ctx().db.update(shareLinks).set({ views: sql`${shareLinks.views} + 1`, lastViewedAt: Date.now() }).where(eq(shareLinks.token, link.token))
  // public: only what the page shows (no workspace, creator or internal ids)
  const shared: SharedPage = {
    project: { name: s.name, width: s.width, height: s.height, duration: s.duration, updatedAt: s.updatedAt },
    videoUrl: ex ? `${base}/video${k}` : undefined,
    posterUrl: poster ? `${base}/poster${k}` : undefined,
    allowDownload: link.allowDownload,
    allowComments: link.allowComments,
    ...(ex && link.allowDownload ? { downloadUrl: `${base}/video${k ? `${k}&` : '?'}download=1` } : {}),
  }
  return c.json(shared)
})

/** A password-protected link: the right password gets a key for the page, the video and the comments. */
shareRoutes.post('/:token/unlock', async (c) => {
  const link = await loadLink(c.req.param('token'))
  const b = await body(c, z.object({ password: z.string().max(SHARE_PASSWORD_MAX) }))
  if (!link.passwordHash) return c.json({ key: '' })
  await hit([{ key: `share-pw:${link.token}:${clientIp(c)}`, limit: 10, windowMs: 15 * 60_000, message: 'Too many wrong passwords.' }])
  if (!(await verifyPassword(b.password, link.passwordHash))) throw new HttpError(403, 'forbidden', 'That password isn’t right.')
  return c.json({ key: accessKey(link) })
})

/** Change a link's settings: expiry, password, downloads, comments (editors). */
shareRoutes.patch('/:token', async (c) => {
  const u = requireUser(c)
  const link = await loadLink(c.req.param('token'))
  const project = await loadProjectRow(link.projectId)
  await requireRole(u.id, project.workspaceId, 'editor')
  const { set, changes } = await settingsPatch(await body(c, SettingsSchema))
  if (!changes.length) return c.json((await linkDetails([link]))[0])
  const [updated] = await ctx().db.update(shareLinks).set(set).where(eq(shareLinks.token, link.token)).returning()
  await recordActivity({ workspaceId: project.workspaceId, projectId: project.id, actorId: u.id, kind: 'share.changed', data: { project: project.name, changes } })
  return c.json((await linkDetails([updated]))[0])
})

/** Stop sharing: the link's page and video stop working at once. */
shareRoutes.delete('/:token', async (c) => {
  const u = requireUser(c)
  const link = await loadLink(c.req.param('token'))
  const project = await loadProjectRow(link.projectId)
  await requireRole(u.id, project.workspaceId, 'editor')
  await ctx().db.delete(shareLinks).where(eq(shareLinks.token, link.token))
  await recordActivity({ workspaceId: project.workspaceId, projectId: project.id, actorId: u.id, kind: 'share.revoked', data: { project: project.name } })
  return c.json({ ok: true })
})

shareRoutes.on(['GET', 'HEAD'], '/:token/video', async (c) => {
  const { link, ex } = await resolveShare(c)
  if (!ex) throw notFound('No export has been rendered for this project yet')
  if (c.req.query('download') === '1' && !link.allowDownload) throw new HttpError(403, 'forbidden', 'Downloads are turned off for this link.')
  const a = await loadAsset(ex.assetId)
  const t = variantTarget(a, 'source')!
  return serveObject(c, { ...t, filename: a.name }, { cache: link.passwordHash ? 'private, max-age=300' : 'public, max-age=300' })
})

/** The shared export's thumbnail, for the page's poster: public like the video, and only while the link works. */
shareRoutes.on(['GET', 'HEAD'], '/:token/poster', async (c) => {
  const { link, ex } = await resolveShare(c)
  const a = ex ? await loadAsset(ex.assetId).catch(() => null) : null
  const t = a && variantTarget(a, 'thumb')
  if (!t) throw notFound('This video has no poster')
  return serveObject(c, t, { cache: link.passwordHash ? 'private, max-age=300' : 'public, max-age=300' })
})

/** Review comments on the share page (E-22): only on a link that allows them; times are in the shared video. */
shareRoutes.get('/:token/comments', async (c) => {
  const { link, project, ex } = await resolveShare(c)
  if (!link.allowComments) throw new HttpError(403, 'forbidden', 'Comments are turned off for this link.')
  return c.json(await commentDtos(await projectComments(project.id), { moderator: false }, await exportOffset(ex)))
})

shareRoutes.post('/:token/comments', async (c) => {
  const { link, project, ex } = await resolveShare(c)
  if (!link.allowComments) throw new HttpError(403, 'forbidden', 'Comments are turned off for this link.')
  const b = await body(c, NewCommentSchema)
  if (!b.name) throw new HttpError(400, 'invalid', 'Add your name so the team knows who commented.')
  await hit([{ key: `share-comment:${clientIp(c)}`, limit: 60, windowMs: 3600_000, message: 'Too many comments from this network.' }])
  const offset = await exportOffset(ex)
  const row = await addComment(project, b, { name: b.name, shareToken: link.token }, offset)
  const [mine] = await commentDtos([row], { moderator: false }, offset)
  const [forTeam] = await commentDtos([row], { moderator: false })
  announceComment(project.workspaceId, { projectId: project.id, comment: { ...forTeam, canEdit: false, canDelete: false } })
  return c.json(mine)
})
