// Signed-in user + active workspace. Shared by the shell and the editor.
//
// The session ends three ways, and every one lands on the sign-in page (the editor keeps its tab, see App):
// - Sign out here: what the person left in this tab (job list, uploads, drafts) is cleared, and other tabs follow.
// - Sign out in another tab: this tab hears it (a `storage` event), checks, and signs out too.
// - The session expires: the first request answered 401 is checked against /auth/me and, if that is 401 too, the
//   app shows signed-out with a note. Nothing is cleared, so signing back in as the same person picks up where it was.
// Signing in as someone else than the last person in this tab clears the previous person's state first.
import type { MeResponse, User, Workspace } from '@producer/core'
import { create } from 'zustand'
import { api, HttpError, setUnauthorizedHandler } from './api'

interface SessionState {
  status: 'loading' | 'anon' | 'ready'
  user?: User
  workspaces: Workspace[]
  workspaceId?: string
  /** Why the app is signed out, when it didn't start that way (for a note on the sign-in page). */
  signedOutReason?: 'expired' | 'elsewhere'
  load: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string, name: string) => Promise<void>
  logout: () => Promise<void>
  setWorkspace: (id: string) => void
  refreshWorkspaces: () => Promise<void>
}

const WS_KEY = 'ps.workspace'
/** Cross-tab session news: `{ kind: 'signed-in' | 'signed-out', userId?, at }`. */
export const SESSION_EVENT_KEY = 'ps.session'

/** Owners and editors change things in a space; viewers look, play and download. */
export const canEdit = (ws: Pick<Workspace, 'role'> | undefined): boolean => ws?.role === 'owner' || ws?.role === 'editor'

/** The active workspace (selector for useSession). */
export const currentWorkspace = (s: Pick<SessionState, 'workspaces' | 'workspaceId'>): Workspace | undefined => s.workspaces.find((w) => w.id === s.workspaceId)

function pickWorkspace(list: Workspace[]): string | undefined {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(WS_KEY)
  } catch {
    /* storage unavailable */
  }
  return list.find((w) => w.id === saved)?.id ?? list.find((w) => w.personal)?.id ?? list[0]?.id
}

// ---------------- per-person state ----------------
const resetHooks = new Set<() => void>()
const beforeSignOutHooks = new Set<() => void | Promise<void>>()

/**
 * Clear what one person left in this tab (a store's contents, a draft). Runs on sign-out and before a different
 * person's session is adopted. Returns an unsubscribe.
 */
export function onUserReset(fn: () => void): () => void {
  resetHooks.add(fn)
  return () => void resetHooks.delete(fn)
}

/** Runs before an explicit sign-out while the session still works (flush unsaved preferences to the right account). */
export function beforeSignOut(fn: () => void | Promise<void>): () => void {
  beforeSignOutHooks.add(fn)
  return () => void beforeSignOutHooks.delete(fn)
}

/** Producer AI drafts are kept per tab under ps.producer.*; they belong to whoever made them. */
function clearSessionDrafts() {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith('ps.producer.')) sessionStorage.removeItem(k)
  } catch {
    /* storage unavailable */
  }
}

/** The person whose state this tab holds (survives an expired session, so the same person can resume). */
let tabUser: string | undefined

function resetUserState() {
  clearSessionDrafts()
  for (const fn of resetHooks) {
    try {
      fn()
    } catch (e) {
      console.error('[session] reset failed', e)
    }
  }
}

function announce(kind: 'signed-in' | 'signed-out', userId?: string) {
  try {
    localStorage.setItem(SESSION_EVENT_KEY, JSON.stringify({ kind, userId, at: Date.now() }))
  } catch {
    /* storage unavailable */
  }
}

let loading: Promise<void> | undefined

export const useSession = create<SessionState>((set, get) => {
  /** Take on a signed-in answer; a different person than this tab's last one starts from a clean tab. */
  function adopt(me: MeResponse) {
    if (tabUser && tabUser !== me.user.id) resetUserState()
    tabUser = me.user.id
    set({ status: 'ready', user: me.user, workspaces: me.workspaces, workspaceId: pickWorkspace(me.workspaces), signedOutReason: undefined })
  }
  return {
    status: 'loading',
    workspaces: [],
    load() {
      // one check at a time: the boot check, StrictMode's second effect and the sign-in page's retry share it
      if (loading) return loading
      loading = (async () => {
        // Retry network errors and 5xx (server restarting, desktop server still booting) before treating the
        // user as signed out; only a real 401 means "anonymous".
        for (let attempt = 0; ; attempt++) {
          try {
            adopt(await api.me())
            return
          } catch (e) {
            const transient = !(e instanceof HttpError) || e.status >= 500
            if (!transient || attempt >= 4) {
              set({ status: 'anon', user: undefined, workspaces: [] })
              return
            }
            await new Promise((r) => setTimeout(r, 400 * 2 ** attempt))
          }
        }
      })().finally(() => {
        loading = undefined
      })
      return loading
    },
    async login(email, password) {
      adopt(await api.login(email, password))
      announce('signed-in', get().user?.id)
    },
    async signup(email, password, name) {
      adopt(await api.signup(email, password, name))
      announce('signed-in', get().user?.id)
    },
    async logout() {
      await Promise.allSettled([...beforeSignOutHooks].map(async (fn) => fn()))
      await api.logout().catch(() => undefined)
      resetUserState()
      tabUser = undefined
      set({ status: 'anon', user: undefined, workspaces: [], workspaceId: undefined, signedOutReason: undefined })
      announce('signed-out')
    },
    setWorkspace(id) {
      try {
        localStorage.setItem(WS_KEY, id)
      } catch {
        /* ignore */
      }
      set({ workspaceId: id })
    },
    async refreshWorkspaces() {
      const list = await api.workspaces()
      const cur = get().workspaceId
      if (cur && list.some((w) => w.id === cur)) return set({ workspaces: list })
      // the active space is gone (deleted or left): fall back to the saved one, else personal
      set({ workspaces: list })
      const next = pickWorkspace(list)
      if (next) get().setWorkspace(next)
      else set({ workspaceId: undefined })
    },
  }
})

// ---------------- an ended session, noticed ----------------
let checking: Promise<void> | undefined

/**
 * Some request was answered 401. Most mean the session ended, but a few 401s are about other credentials (a
 * desktop's cloud password), so ask /auth/me before signing the tab out. `reason` is what the sign-in page says.
 */
export function confirmSignedOut(reason: 'expired' | 'elsewhere' = 'expired'): Promise<void> {
  if (useSession.getState().status !== 'ready') return Promise.resolve()
  checking ??= api
    .me()
    .then(
      () => undefined,
      (e) => {
        if (!(e instanceof HttpError) || e.status !== 401 || useSession.getState().status !== 'ready') return
        // signed out elsewhere: that person left on purpose, so clear what they left here too
        if (reason === 'elsewhere') {
          resetUserState()
          tabUser = undefined
        }
        useSession.setState({ status: 'anon', user: undefined, workspaces: [], workspaceId: undefined, signedOutReason: reason })
      },
    )
    .finally(() => {
      checking = undefined
    })
  return checking
}

setUnauthorizedHandler(() => void confirmSignedOut('expired'))

/** Another tab signed in or out (exported for tests). */
export function onSessionEvent(raw: string | null) {
  let ev: { kind?: string; userId?: string } | undefined
  try {
    ev = raw ? JSON.parse(raw) : undefined
  } catch {
    return
  }
  const s = useSession.getState()
  if (ev?.kind === 'signed-out') void confirmSignedOut('elsewhere')
  else if (ev?.kind === 'signed-in' && (s.status === 'anon' || (s.status === 'ready' && ev.userId !== s.user?.id))) void s.load()
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === SESSION_EVENT_KEY) onSessionEvent(e.newValue)
  })
}
