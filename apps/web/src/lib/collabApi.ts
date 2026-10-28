// Client for the collaboration routes (contract: packages/core/src/collab.ts): share-link settings, review comments,
// presence and the activity feed. Kept beside lib/api.ts so the two change independently.
import type { ActivityEntry, CreateShareRequest, NewComment, Page, ProjectPresence, ReviewComment, ShareLinkDetails, ShareLinkSettings, SharedPage } from '@producer/core'
import { HttpError, noteStatus } from './api'

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, credentials: RequestCredentials = 'include'): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (credentials === 'include') noteStatus(path, res.status)
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

export const collabApi = {
  // share links (A-16)
  projectShares: (projectId: string) => call<ShareLinkDetails[]>('GET', `/projects/${enc(projectId)}/shares`),
  spaceShares: (workspaceId: string) => call<ShareLinkDetails[]>('GET', `/workspaces/${enc(workspaceId)}/shares`),
  createShare: (projectId: string, body: CreateShareRequest = {}) => call<ShareLinkDetails>('POST', `/projects/${enc(projectId)}/share`, body),
  updateShare: (token: string, body: ShareLinkSettings) => call<ShareLinkDetails>('PATCH', `/share/${enc(token)}`, body),
  revokeShare: (token: string) => call<{ ok: true }>('DELETE', `/share/${enc(token)}`),

  // comments (E-22)
  comments: (projectId: string) => call<ReviewComment[]>('GET', `/projects/${enc(projectId)}/comments`),
  addComment: (projectId: string, body: NewComment) => call<ReviewComment>('POST', `/projects/${enc(projectId)}/comments`, body),
  updateComment: (id: string, body: { body?: string; resolved?: boolean }) => call<ReviewComment>('PATCH', `/comments/${enc(id)}`, body),
  deleteComment: (id: string) => call<{ ok: true; removed: string[] }>('DELETE', `/comments/${enc(id)}`),

  // presence and activity (A-23)
  presence: (projectId: string) => call<ProjectPresence>('GET', `/projects/${enc(projectId)}/presence`),
  beat: (projectId: string, client: string, open = true) => call<ProjectPresence>('POST', `/projects/${enc(projectId)}/presence`, { client, open }),
  activity: (workspaceId: string, cursor?: string) => call<Page<ActivityEntry>>('GET', `/workspaces/${enc(workspaceId)}/activity?limit=50${cursor ? `&cursor=${enc(cursor)}` : ''}`),
}

/** The public share page's calls: no account, no cookies; a password-protected link sends its key. */
export const shareApi = {
  page: (token: string, key?: string) => call<SharedPage>('GET', `/share/${enc(token)}`, undefined, key ? { 'x-share-key': key } : {}, 'omit'),
  unlock: (token: string, password: string) => call<{ key: string }>('POST', `/share/${enc(token)}/unlock`, { password }, {}, 'omit'),
  comments: (token: string, key?: string) => call<ReviewComment[]>('GET', `/share/${enc(token)}/comments`, undefined, key ? { 'x-share-key': key } : {}, 'omit'),
  addComment: (token: string, body: NewComment, key?: string) => call<ReviewComment>('POST', `/share/${enc(token)}/comments`, body, key ? { 'x-share-key': key } : {}, 'omit'),
}
