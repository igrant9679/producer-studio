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
    try {
      const me = await api.me()
      set({ status: 'ready', user: me.user, workspaces: me.workspaces, workspaceId: pickWorkspace(me.workspaces) })
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) set({ status: 'anon', user: undefined, workspaces: [] })
      else set({ status: 'anon' })
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
