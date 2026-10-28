// The open project's review comments (E-22): loaded with the project, kept current by `comment` live updates, and
// changed through the comment routes. Viewers comment too; resolving someone else's thread and removing other
// people's comments are for editors (the server checks the same).
import type { ReviewComment } from '@producer/core'
import { create } from 'zustand'
import { collabApi } from '../../lib/collabApi'
import { useSession } from '../../lib/session'
import { toastError } from '../../lib/toast'
import { useEditor } from '../store'

interface CommentsState {
  projectId?: string
  list: ReviewComment[]
  loading: boolean
  error?: string
  showResolved: boolean
  /** The thread the panel shows highlighted (picked on the ruler). */
  activeId?: string
  /** Choosing the new comment's point on the canvas. */
  picking: boolean
  point?: { x: number; y: number }
  set: (p: Partial<CommentsState>) => void
}

export const useComments = create<CommentsState>((set) => ({ list: [], loading: false, showResolved: false, picking: false, set: (p) => set(p) }))

/** What the person may do with a comment, worked out here for comments that arrive live. */
function withRights(c: ReviewComment): ReviewComment {
  const me = useSession.getState().user?.id
  const mine = !!me && c.author.id === me
  return { ...c, canEdit: mine, canDelete: mine || !useEditor.getState().readOnly }
}

export async function loadComments(projectId: string) {
  useComments.setState({ projectId, list: [], loading: true, error: undefined, activeId: undefined, picking: false, point: undefined })
  try {
    const list = await collabApi.comments(projectId)
    if (useComments.getState().projectId === projectId) useComments.setState({ list, loading: false })
  } catch (e) {
    if (useComments.getState().projectId === projectId) useComments.setState({ loading: false, error: e instanceof Error ? e.message : String(e) })
  }
}

export function resetComments() {
  useComments.setState({ projectId: undefined, list: [], loading: false, error: undefined, activeId: undefined, picking: false, point: undefined })
}

function upsert(c: ReviewComment) {
  const s = useComments.getState()
  if (c.projectId !== s.projectId) return
  const i = s.list.findIndex((x) => x.id === c.id)
  useComments.setState({ list: i < 0 ? [...s.list, c] : s.list.map((x) => (x.id === c.id ? c : x)) })
}

/** A `comment` live update: someone added, changed or removed comments on a project of this space. */
export function onCommentEvent(ev: { projectId: string; comment?: ReviewComment; removed?: string[] }) {
  const s = useComments.getState()
  if (ev.projectId !== s.projectId) return
  if (ev.comment) upsert(withRights(ev.comment))
  if (ev.removed?.length) {
    const gone = new Set(ev.removed)
    useComments.setState({ list: s.list.filter((c) => !gone.has(c.id)), activeId: s.activeId && gone.has(s.activeId) ? undefined : s.activeId })
  }
}

/** A new thread at the playhead (and the picked point, if any), or a reply. */
export async function addComment(body: string, opts: { parentId?: string; at?: number } = {}): Promise<boolean> {
  const s = useComments.getState()
  if (!s.projectId) return false
  try {
    const point = opts.parentId ? undefined : s.point
    const c = await collabApi.addComment(s.projectId, { body, ...(opts.parentId ? { parentId: opts.parentId } : { at: opts.at ?? useEditor.getState().playhead, ...(point ?? {}) }) })
    upsert(c)
    if (!opts.parentId) useComments.setState({ point: undefined, picking: false, activeId: c.id })
    return true
  } catch (e) {
    toastError(e, 'Couldn’t add the comment')
    return false
  }
}

export async function resolveComment(id: string, resolved: boolean) {
  try {
    upsert(await collabApi.updateComment(id, { resolved }))
  } catch (e) {
    toastError(e, resolved ? 'Couldn’t resolve it' : 'Couldn’t reopen it')
  }
}

export async function removeComment(id: string) {
  try {
    const r = await collabApi.deleteComment(id)
    onCommentEvent({ projectId: useComments.getState().projectId ?? '', removed: r.removed })
  } catch (e) {
    toastError(e, 'Couldn’t remove the comment')
  }
}
