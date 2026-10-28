// The space-wide exports list and export deletes (A-19, P-23), and search across a space (A-11).
import { Hono } from 'hono'
import { type SQL, and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { VOICES, searchSnippet, searchWords, type DeleteExportResult, type SearchHit, type SearchResults, type SpaceExport } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { assets, exportsTable, memberships, projects, users, voiceProfiles } from '../db/schema'
import { assetRecord, exportDto, mediaPath, projectSummary } from '../dto'
import { HttpError, invalid, notFound, requireRole } from '../http'
import { afterCursor, pageOrder, pageQuery, toPage } from '../paging'
import { deleteExport } from '../services/library'
import { loadLooks } from '../services/looks'
import { recordActivity } from '../services/activity'

/** `%word%` for ILIKE, with the pattern characters in the word taken literally. */
const like = (w: string) => `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

/** Every word appears in `expr` (case-insensitive, any order). */
function allWords(expr: SQL, words: string[]): SQL {
  return and(...words.map((w) => sql`${expr} ILIKE ${like(w)}`))!
}

/** Mounted at /api/exports before the per-project list: `?workspaceId=` lists every export of the space. */
export const spaceExportRoutes = new Hono<AppEnv>()

const EXPORT_FORMATS = ['mp4', 'webm', 'gif', 'mp3', 'wav']

spaceExportRoutes.get('/', async (c, next) => {
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId || c.req.query('projectId')) return next()
  const u = requireUser(c)
  await requireRole(u.id, workspaceId, 'viewer')
  const { limit, after } = pageQuery(c)
  const words = searchWords(c.req.query('q') ?? '')
  const formats = (c.req.query('format') ?? '').split(',').filter((f) => EXPORT_FORMATS.includes(f))
  const conds: Array<SQL | undefined> = [eq(exportsTable.workspaceId, workspaceId), eq(projects.workspaceId, workspaceId), isNull(projects.trashedAt), afterCursor(exportsTable.createdAt, exportsTable.id, after)]
  if (formats.length) conds.push(inArray(exportsTable.format, formats))
  if (words.length) conds.push(allWords(sql`(${exportsTable.name} || ' ' || ${projects.name})`, words))
  const rows = await ctx()
    .db.select({
      ex: exportsTable,
      projectName: projects.name,
      thumbnail: projects.thumbnail,
      captions: sql<boolean>`EXISTS (SELECT 1 FROM assets a WHERE a.id = ${exportsTable.assetId} AND a.meta -> 'captions' IS NOT NULL)`,
      shares: sql<number>`(SELECT count(*)::int FROM share_links l WHERE l.export_id = ${exportsTable.id})`,
    })
    .from(exportsTable)
    .innerJoin(projects, eq(projects.id, exportsTable.projectId))
    .where(and(...conds))
    .orderBy(...pageOrder(exportsTable.createdAt, exportsTable.id))
    .limit(limit + 1)
  return c.json(
    toPage(
      rows,
      limit,
      (r) => [r.ex.createdAt, r.ex.id],
      (r): SpaceExport => ({
        ...exportDto(r.ex, !!r.captions),
        projectName: r.projectName,
        ...(r.thumbnail ? { projectThumbnailUrl: mediaPath(r.thumbnail, 'thumb') } : {}),
        assetId: r.ex.assetId,
        shares: Number(r.shares) || 0,
      }),
    ),
  )
})

/** Delete an export (editors): its share links stop working; its file goes unless a project uses it. */
spaceExportRoutes.delete('/:id', async (c) => {
  const u = requireUser(c)
  const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, c.req.param('id'))).limit(1))[0]
  if (!ex) throw notFound('Export not found')
  await requireRole(u.id, ex.workspaceId, 'editor')
  const r = await deleteExport(ex)
  if (r.links) await recordActivity({ workspaceId: ex.workspaceId, projectId: ex.projectId, actorId: u.id, kind: 'share.revoked', data: { project: ex.name } })
  const res: DeleteExportResult = { ok: true, ...r }
  return c.json(res)
})

// ---------------- search ----------------

export const searchRoutes = new Hono<AppEnv>()

/** Results per kind of thing. */
const PER_KIND = 8

/** The segments of a clip's transcript as rows (none when it has no transcript). */
const segmentsOf = (meta: SQL | typeof assets.meta) =>
  sql`jsonb_array_elements(CASE WHEN jsonb_typeof(${meta} -> 'transcript' -> 'segments') = 'array' THEN ${meta} -> 'transcript' -> 'segments' ELSE '[]'::jsonb END)`
/** A Producer AI project's script scenes as rows. */
const scenesOf = (doc: typeof projects.doc) =>
  sql`jsonb_array_elements(CASE WHEN jsonb_typeof(${doc} -> 'ai' -> 'script' -> 'scenes') = 'array' THEN ${doc} -> 'ai' -> 'script' -> 'scenes' ELSE '[]'::jsonb END)`

/**
 * Search a space: projects and templates (name, tags, a Producer AI script's narration), media (name, the words said
 * in its transcript, a voiceover's text), voices, exports and members. Case-insensitive; every word must appear,
 * in any order. Plain ILIKE (no extensions), so it runs the same on PGlite and Postgres.
 */
searchRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) throw invalid('workspaceId is required')
  await requireRole(u.id, workspaceId, 'viewer')
  const q = (c.req.query('q') ?? '').slice(0, 200)
  const words = searchWords(q)
  if (!words.length) return c.json({ q, hits: [] } satisfies SearchResults)
  if (words.some((w) => w.length > 100)) throw new HttpError(400, 'invalid', 'That search is too long')
  const db = ctx().db
  const hits: SearchHit[] = []

  // projects and templates: the name or tags, else a scene's narration
  const narration = sql<string | null>`(SELECT s ->> 'narration' FROM ${scenesOf(projects.doc)} s WHERE ${allWords(sql`(s ->> 'narration')`, words)} LIMIT 1)`
  const nameHit = allWords(sql`(${projects.name} || ' ' || coalesce((${projects.doc} -> 'tags')::text, ''))`, words)
  const ps = await db
    .select({ p: { id: projects.id, workspaceId: projects.workspaceId, name: projects.name, kind: projects.kind, version: projects.version, thumbnail: projects.thumbnail, duration: projects.duration, width: projects.width, height: projects.height, isTemplate: projects.isTemplate, trashedAt: projects.trashedAt, createdBy: projects.createdBy, createdAt: projects.createdAt, updatedAt: projects.updatedAt, changeSeq: projects.changeSeq }, tags: sql<string[] | null>`${projects.doc} -> 'tags'`, nameHit: sql<boolean>`${nameHit}`, narration })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.trashedAt), or(nameHit, sql`${narration} IS NOT NULL`)))
    .orderBy(desc(projects.updatedAt))
    .limit(PER_KIND * 2)
  const byKind = (k: SearchHit['kind']) => hits.filter((h) => h.kind === k).length
  for (const r of ps) {
    const kind = r.p.isTemplate ? 'template' : 'project'
    if (byKind(kind) >= PER_KIND) continue
    const s = projectSummary({ ...r.p, doc: undefined as never }, { tags: Array.isArray(r.tags) ? r.tags : null })
    hits.push({
      kind,
      id: s.id,
      title: s.name,
      ...(r.nameHit ? (s.tags?.length ? { detail: s.tags.join(', ') } : {}) : { detail: 'Said in its narration', snippet: searchSnippet(r.narration ?? '', words) }),
      ...(s.thumbnailUrl ? { thumbnailUrl: s.thumbnailUrl } : {}),
      project: s,
    })
  }

  // media: the name, a voiceover's text, or the first transcript segment with every word in it
  const said = sql<{ t: string; at: number } | null>`(SELECT jsonb_build_object('t', s ->> 'text', 'at', s -> 'start') FROM ${segmentsOf(assets.meta)} s WHERE ${allWords(sql`(s ->> 'text')`, words)} LIMIT 1)`
  const clipName = allWords(sql`${assets.name}`, words)
  const voiced = allWords(sql`coalesce(${assets.meta} -> 'tts' ->> 'text', '')`, words)
  const as = await db
    .select({ a: assets, nameHit: sql<boolean>`${clipName}`, voiced: sql<boolean>`${voiced}`, said })
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), isNull(assets.trashedAt), or(clipName, voiced, sql`${said} IS NOT NULL`)))
    .orderBy(desc(assets.createdAt))
    .limit(PER_KIND + 4)
  for (const r of as) {
    const rec = assetRecord(r.a, { light: true })
    const base = { kind: 'media' as const, id: r.a.id, title: r.a.name, assetId: r.a.id, asset: rec, ...(rec.asset.thumbnail ? { thumbnailUrl: rec.asset.thumbnail } : {}) }
    if (r.nameHit) hits.push(base)
    else if (r.said) hits.push({ ...base, detail: 'Said in the clip', snippet: searchSnippet(r.said.t, words), at: Number(r.said.at) || 0 })
    else hits.push({ ...base, detail: 'In the voiceover’s text', snippet: searchSnippet(r.a.meta?.tts?.text ?? '', words) })
  }

  // voices: the space's own voices and the built-in ones
  const vs = await db
    .select({ id: voiceProfiles.id, name: voiceProfiles.name, description: voiceProfiles.description, kind: voiceProfiles.kind })
    .from(voiceProfiles)
    .where(and(eq(voiceProfiles.workspaceId, workspaceId), allWords(sql`(${voiceProfiles.name} || ' ' || coalesce(${voiceProfiles.description}, ''))`, words)))
    .limit(PER_KIND)
  for (const v of vs) hits.push({ kind: 'voice', id: `vs:${v.id}`, title: v.name, detail: v.description || (v.kind === 'clone' ? 'Cloned voice' : 'Designed voice') })
  const matchesAll = (text: string) => words.every((w) => text.toLowerCase().includes(w))
  for (const v of VOICES) if (byKind('voice') < PER_KIND && matchesAll(`${v.name} ${v.lang} ${v.gender} ${v.style}`)) hits.push({ kind: 'voice', id: v.id, title: v.name, detail: `${v.style} · ${v.lang}` })

  // built-in templates (looks)
  for (const l of loadLooks()) if (byKind('template') < PER_KIND && matchesAll(`${l.name} ${l.category ?? ''}`)) hits.push({ kind: 'template', id: `tpl:${l.id}`, title: l.name, detail: `Built-in template · ${l.category ?? ''}`.replace(/ · $/, '') })

  // exports
  const exs = await db
    .select({ id: exportsTable.id, name: exportsTable.name, projectId: exportsTable.projectId, projectName: projects.name, format: exportsTable.format, resolution: exportsTable.resolution, createdAt: exportsTable.createdAt })
    .from(exportsTable)
    .innerJoin(projects, eq(projects.id, exportsTable.projectId))
    .where(and(eq(exportsTable.workspaceId, workspaceId), isNull(projects.trashedAt), allWords(sql`(${exportsTable.name} || ' ' || ${projects.name})`, words)))
    .orderBy(desc(exportsTable.createdAt))
    .limit(PER_KIND)
  for (const e of exs) hits.push({ kind: 'export', id: e.id, title: e.name || e.projectName, detail: `${e.format.toUpperCase()}${e.resolution !== 'audio' ? ` ${e.resolution}` : ''} · ${e.projectName}`, projectId: e.projectId })

  // members (name or email)
  const ms = await db
    .select({ id: users.id, name: users.name, email: users.email, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), allWords(sql`(${users.name} || ' ' || ${users.email})`, words)))
    .limit(PER_KIND)
  for (const m of ms) hits.push({ kind: 'member', id: m.id, title: m.name, detail: `${m.email} · ${m.role}` })

  return c.json({ q, hits } satisfies SearchResults)
})
