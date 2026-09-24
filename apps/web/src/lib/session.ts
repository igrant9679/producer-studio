// Signed-in user + active workspace. Shared by the shell and the editor.
import type { User, Workspace } from '@producer/core'
import { create } from 'zustand'
import { api, HttpError } from './api'

interface SessionState {
  status: 'loading' | 'anon' | 'ready'
  user?: User
  workspaces: Workspace[]
  workspaceId?: string
  load: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string, name: string) => Promise<void>
  logout: () => Promise<void>
  setWorkspace: (id: string) => void
  refreshWorkspaces: () => Promise<void>
}

const WS_KEY = 'ps.workspace'

function pickWorkspace(list: Workspace[]): string | undefined {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(WS_KEY)
  } catch {
    /* storage unavailable */
  }
  return list.find((w) => w.id === saved)?.id ?? list.find((w) => w.personal)?.id ?? list[0]?.id
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  workspaces: [],
  async load() {
    // Retry network errors and 5xx (server restarting, desktop server still booting) before treating the
    // user as signed out; only a real 401 means "anonymous".
    for (let attempt = 0; ; attempt++) {
      try {
        const me = await api.me()
        set({ status: 'ready', user: me.user, workspaces: me.workspaces, workspaceId: pickWorkspace(me.workspaces) })
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
  },
  async login(email, password) {
    const me = await api.login(email, password)
    set({ status: 'ready', user: me.user, workspaces: me.workspaces, workspaceId: pickWorkspace(me.workspaces) })
  },
  async signup(email, password, name) {
    const me = await api.signup(email, password, name)
    set({ status: 'ready', user: me.user, workspaces: me.workspaces, workspaceId: pickWorkspace(me.workspaces) })
  },
  async logout() {
    await api.logout().catch(() => undefined)
    set({ status: 'anon', user: undefined, workspaces: [], workspaceId: undefined })
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
    set({ workspaces: list, workspaceId: get().workspaceId ?? pickWorkspace(list) })
  },
}))
