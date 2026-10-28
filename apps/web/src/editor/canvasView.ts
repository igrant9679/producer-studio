// Canvas view aids: rulers, guides and the platform safe-zone overlay. They are the person's own view (this
// browser), not part of the project: guides are kept per project, the rest for every project.
import { create } from 'zustand'
import type { SafeZoneId } from './canvasSnap'

export interface Guides {
  /** Vertical guides (x, canvas px) and horizontal ones (y). */
  v: number[]
  h: number[]
}

interface CanvasViewState {
  rulers: boolean
  safeZone: SafeZoneId | null
  projectId: string
  guides: Guides
  setRulers: (on: boolean) => void
  setSafeZone: (z: SafeZoneId | null) => void
  /** Load this project's guides (call when a project opens). */
  openProject: (projectId: string) => void
  setGuides: (g: Guides) => void
}

const VIEW_KEY = 'ps.canvasView'
const guidesKey = (id: string) => `ps.guides.${id}`

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* private mode or full: the view just isn't remembered */
  }
}

const clean = (list: unknown): number[] => (Array.isArray(list) ? list.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(0, 100) : [])

const saved = read<{ rulers: boolean; safeZone: SafeZoneId | null }>(VIEW_KEY, { rulers: false, safeZone: null })

export const useCanvasView = create<CanvasViewState>((set, get) => ({
  rulers: !!saved.rulers,
  safeZone: saved.safeZone ?? null,
  projectId: '',
  guides: { v: [], h: [] },
  setRulers: (rulers) => {
    set({ rulers })
    write(VIEW_KEY, { rulers, safeZone: get().safeZone })
  },
  setSafeZone: (safeZone) => {
    set({ safeZone })
    write(VIEW_KEY, { rulers: get().rulers, safeZone })
  },
  openProject: (projectId) => {
    if (projectId === get().projectId) return
    const g = read<Guides>(guidesKey(projectId), { v: [], h: [] })
    set({ projectId, guides: { v: clean(g.v), h: clean(g.h) } })
  },
  setGuides: (guides) => {
    const g = { v: clean(guides.v).map((n) => Math.round(n)), h: clean(guides.h).map((n) => Math.round(n)) }
    set({ guides: g })
    const id = get().projectId
    if (id) write(guidesKey(id), g)
  },
}))

export const toggleRulers = () => useCanvasView.getState().setRulers(!useCanvasView.getState().rulers)
