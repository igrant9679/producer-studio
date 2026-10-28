// Collaboration (Phase 5, release 2): share links with settings, timecoded review comments, an activity feed per
// space, and who has a project open. Types shared by the server and the web app, and the small pure helpers both use.
//
// Routes (server: routes/share.ts, routes/collab.ts):
// GET    /api/projects/:id/shares                  -> ShareLinkDetails[]  (viewer)
// GET    /api/workspaces/:id/shares                -> ShareLinkDetails[]  (viewer: every project's links in the space)
// POST   /api/projects/:id/share  CreateShareRequest -> ShareLinkDetails (editor; the same export's link is reused
//                                                    unless `new`)
// PATCH  /api/share/:token        ShareLinkSettings  -> ShareLinkDetails (editor)
// DELETE /api/share/:token                          -> {ok}  (editor: revoke)
// GET    /api/share/:token        (public)          -> SharedPage; 401 code 'password' until unlocked, 410 expired
// POST   /api/share/:token/unlock {password}        -> {key}  (public; the key goes on as ?k= or X-Share-Key)
// GET    /api/share/:token/comments (public, when the link allows comments) -> ReviewComment[] (times in the video)
// POST   /api/share/:token/comments NewComment      -> ReviewComment (public: a name, no account)
// GET    /api/projects/:id/comments                -> ReviewComment[]  (viewer)
// POST   /api/projects/:id/comments NewComment      -> ReviewComment  (viewer: viewers comment too)
// PATCH  /api/comments/:id {body?, resolved?}       -> ReviewComment  (resolve: editors and the author; body: author)
// DELETE /api/comments/:id                          -> {ok}  (the author or an editor; a thread's first comment takes
//                                                    its replies with it)
// GET    /api/workspaces/:id/activity?cursor=       -> Page<ActivityEntry>  (viewer)
// GET    /api/projects/:id/presence                 -> ProjectPresence  (viewer)
// POST   /api/projects/:id/presence {client, open}  -> ProjectPresence  (viewer; a heartbeat every PRESENCE_BEAT_MS)
// Live updates on the workspace stream: `presence` (ProjectPresence) and `comment` ({projectId, comment?, removed?}).
import type { Role, ShareLink, SharedVideo } from './api'

// ---------------- share links (A-16) ----------------
export interface ShareLinkSettings {
  /** Epoch ms; null never expires. */
  expiresAt?: number | null
  /** A new password, or null to remove it. Never sent back. */
  password?: string | null
  allowDownload?: boolean
  allowComments?: boolean
}

export interface CreateShareRequest extends ShareLinkSettings {
  exportId?: string
  /** Make another link even when this export already has one (different settings for different people). */
  new?: boolean
}

export interface ShareLinkDetails extends ShareLink {
  projectId: string
  projectName: string
  exportName?: string
  createdBy: { id: string; name: string }
  views: number
  lastViewedAt?: number
  expiresAt: number | null
  expired: boolean
  hasPassword: boolean
  allowDownload: boolean
  allowComments: boolean
}

/** The public share page's answer. */
export interface SharedPage extends SharedVideo {
  allowDownload: boolean
  allowComments: boolean
  /** The video as a file (only when the link allows downloads). */
  downloadUrl?: string
}

export const SHARE_PASSWORD_MIN = 4
export const SHARE_PASSWORD_MAX = 200

// ---------------- review comments (E-22) ----------------
export interface ReviewComment {
  id: string
  projectId: string
  /** A reply: its thread's first comment. */
  parentId?: string
  author: { id?: string; name: string; color?: string; guest: boolean }
  body: string
  /** Seconds into the project (in the shared video on the share page). Thread roots only. */
  at?: number
  /** A point on the frame, 0–1 from the top left. */
  x?: number
  y?: number
  resolved?: { at: number; by?: string }
  createdAt: number
  updatedAt: number
  /** The asker may change it (their own) or remove it (theirs, or they edit the space). */
  canEdit?: boolean
  canDelete?: boolean
}

export interface NewComment {
  body: string
  at?: number
  x?: number
  y?: number
  parentId?: string
  /** A share-page visitor's name. */
  name?: string
}

export interface CommentThread extends ReviewComment {
  replies: ReviewComment[]
}

export const COMMENT_MAX = 2000
export const COMMENT_NAME_MAX = 60

/** Comments as threads: first comments in time order (timeless ones last), each with its replies oldest first. */
export function threadsOf(list: ReviewComment[]): CommentThread[] {
  const roots = new Map<string, CommentThread>()
  for (const c of list) if (!c.parentId) roots.set(c.id, { ...c, replies: [] })
  for (const c of list) if (c.parentId) roots.get(c.parentId)?.replies.push(c)
  const out = [...roots.values()]
  for (const t of out) t.replies.sort((a, b) => a.createdAt - b.createdAt)
  return out.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.createdAt - b.createdAt)
}

/** Where a thread is pinned, for the ruler: open threads only unless asked. */
export function commentMarks(list: ReviewComment[], opts: { resolved?: boolean } = {}): Array<{ id: string; at: number; resolved: boolean; count: number }> {
  return threadsOf(list)
    .filter((t) => t.at !== undefined && (opts.resolved || !t.resolved))
    .map((t) => ({ id: t.id, at: t.at!, resolved: !!t.resolved, count: 1 + t.replies.length }))
}

// ---------------- activity (A-23) ----------------
export type ActivityKind =
  | 'project.created'
  | 'project.renamed'
  | 'project.exported'
  | 'share.created'
  | 'share.changed'
  | 'share.revoked'
  | 'comment.added'
  | 'member.joined'
  | 'member.role'
  | 'member.removed'
  | 'member.left'

export interface ActivityEntry {
  id: string
  workspaceId: string
  projectId?: string
  actor: { id?: string; name: string }
  kind: ActivityKind
  data: Record<string, unknown>
  createdAt: number
}

const q = (v: unknown) => `“${String(v ?? '')}”`

/** One line for the Activity page ("Ada exported “Launch” (1080p MP4)"). */
export function activitySentence(e: ActivityEntry): string {
  const who = e.actor.name || 'Someone'
  const d = e.data
  const project = q(d.project ?? 'a project')
  switch (e.kind) {
    case 'project.created':
      return `${who} created ${project}`
    case 'project.renamed':
      return `${who} renamed ${q(d.from)} to ${q(d.to)}`
    case 'project.exported':
      return `${who} exported ${project}${d.resolution || d.format ? ` (${[d.resolution, String(d.format ?? '').toUpperCase()].filter(Boolean).join(' ')})` : ''}`
    case 'share.created':
      return `${who} shared ${project}`
    case 'share.changed':
      return `${who} changed a share link of ${project}${Array.isArray(d.changes) && d.changes.length ? `: ${(d.changes as string[]).join(', ')}` : ''}`
    case 'share.revoked':
      return `${who} stopped a share link of ${project}`
    case 'comment.added':
      return `${who}${d.guest ? ' (guest)' : ''} ${d.reply ? 'replied on' : 'commented on'} ${project}`
    case 'member.joined':
      return `${who} joined the space as ${d.role ?? 'a member'}`
    case 'member.role':
      return `${who} made ${d.member ?? 'someone'} ${d.role === 'owner' ? 'an owner' : `an ${d.role}`}`
    case 'member.removed':
      return `${who} removed ${d.member ?? 'someone'} from the space`
    case 'member.left':
      return `${who} left the space`
  }
}

// ---------------- presence (A-23) ----------------
export interface PresenceEntry {
  userId: string
  name: string
  color: string
  role?: Role
  /** When they opened it (the earliest of their tabs). */
  since: number
}

export interface ProjectPresence {
  projectId: string
  people: PresenceEntry[]
}

/** How often an open editor says it is still there; a person goes after PRESENCE_TTL_MS without one. */
export const PRESENCE_BEAT_MS = 20_000
export const PRESENCE_TTL_MS = 50_000
