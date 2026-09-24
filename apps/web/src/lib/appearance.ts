// Appearance engine: theme, accent, text size, density and reduced motion.
//
// The preferences are applied as attributes on <html> (styles/theme.css keys off them):
//   data-theme="dark|light"  (resolved; 'system' follows prefers-color-scheme live)   data-theme-pref="system|dark|light"
//   data-accent  data-density  data-reduce-motion="true|false"  and the inline variable --ui-scale.
// They are cached in localStorage (`ps.appearance`) so public/appearance-boot.js can set the same attributes before
// first paint, and synced with the signed-in user's server copy (GET/PUT /api/me/preferences): on session start the
// server value wins when it is newer than the last local change; local changes are saved debounced.
// Keep resolve/apply in step with public/appearance-boot.js (appearance.test.ts runs both).
import { DEFAULT_PREFERENCES, TEXT_SCALE, normalizePreferences, type PreferencesResponse, type ThemePreference, type UserPreferences } from '@producer/core'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { api } from './api'
import { useSession } from './session'
import { toast } from './toast'

export const STORAGE_KEY = 'ps.appearance'
export type ResolvedTheme = 'dark' | 'light'

/** What localStorage holds. */
export interface StoredAppearance {
  v: 1
  prefs: UserPreferences
  /** Epoch ms of the last local change (0 = never changed on this device). */
  changedAt: number
  /** Local changes not yet saved to the server. */
  dirty: boolean
  /** The user picked reduce motion explicitly (otherwise "off" follows the OS setting). */
  motionExplicit: boolean
}

const THEME_BG: Record<ResolvedTheme, string> = { dark: '#0c0e14', light: '#f3f5f8' }
const CYCLE: ThemePreference[] = ['system', 'dark', 'light']
const THEME_LABEL: Record<ThemePreference, string> = { system: 'System', dark: 'Dark', light: 'Light' }
const SAVE_DEBOUNCE_MS = 600

const media = (q: string): MediaQueryList | undefined => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : undefined)

export function systemTheme(): ResolvedTheme {
  return media('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark'
}

export function systemReducedMotion(): boolean {
  return !!media('(prefers-reduced-motion: reduce)')?.matches
}

export function resolveTheme(pref: ThemePreference, system: ResolvedTheme = systemTheme()): ResolvedTheme {
  return pref === 'system' ? system : pref
}

/** Reduce motion is on when chosen, or when the OS asks for it and the user hasn't chosen either way. */
export function resolveReduceMotion(prefs: UserPreferences, motionExplicit: boolean, systemReduced: boolean = systemReducedMotion()): boolean {
  return prefs.reduceMotion || (!motionExplicit && systemReduced)
}

export function readStored(): StoredAppearance | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const o = JSON.parse(raw) as Partial<StoredAppearance>
    return {
      v: 1,
      prefs: normalizePreferences(o.prefs),
      changedAt: typeof o.changedAt === 'number' ? o.changedAt : 0,
      dirty: o.dirty === true,
      motionExplicit: o.motionExplicit === true,
    }
  } catch {
    return undefined
  }
}

function writeStored(s: StoredAppearance) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable (private mode, quota) */
  }
}

interface DesktopBridge {
  setNativeTheme?: (mode: ThemePreference) => Promise<boolean>
}
const desktopBridge = (): DesktopBridge | undefined => (typeof window !== 'undefined' ? (window as unknown as { producerDesktop?: DesktopBridge }).producerDesktop : undefined)
let lastNativeTheme: ThemePreference | undefined

/** Set the <html> attributes for these preferences. Returns the resolved theme. */
export function applyAppearance(prefs: UserPreferences, opts: { motionExplicit?: boolean; system?: ResolvedTheme; systemReduced?: boolean } = {}, root: HTMLElement = document.documentElement): ResolvedTheme {
  const theme = resolveTheme(prefs.theme, opts.system)
  root.dataset.theme = theme
  root.dataset.themePref = prefs.theme
  root.dataset.accent = prefs.accent
  root.dataset.density = prefs.density
  root.dataset.reduceMotion = String(resolveReduceMotion(prefs, !!opts.motionExplicit, opts.systemReduced))
  root.style.setProperty('--ui-scale', String(TEXT_SCALE[prefs.textSize]))
  const meta = root.ownerDocument.querySelector('meta[name="theme-color"]')
  meta?.setAttribute('content', THEME_BG[theme])
  // Electron: the window frame and native menus follow the app theme
  const bridge = desktopBridge()
  if (bridge?.setNativeTheme && lastNativeTheme !== prefs.theme) {
    lastNativeTheme = prefs.theme
    void bridge.setNativeTheme(prefs.theme).catch(() => undefined)
  }
  return theme
}

interface AppearanceState extends Omit<StoredAppearance, 'v'> {
  /** The theme actually shown. */
  resolved: ResolvedTheme
  /** The OS theme (what 'system' resolves to right now). */
  system: ResolvedTheme
  systemReduced: boolean
  reduceMotionActive: boolean
  /** Change preferences locally (applies instantly, persists, schedules a server save). */
  update: (patch: Partial<UserPreferences>) => void
  reset: () => void
  /** system -> dark -> light -> system. Returns the new preference. */
  cycleTheme: () => ThemePreference
}

const initial = readStored()

export const useAppearance: UseBoundStore<StoreApi<AppearanceState>> = create<AppearanceState>(() => ({
  prefs: initial?.prefs ?? { ...DEFAULT_PREFERENCES },
  changedAt: initial?.changedAt ?? 0,
  dirty: initial?.dirty ?? false,
  motionExplicit: initial?.motionExplicit ?? false,
  resolved: resolveTheme(initial?.prefs.theme ?? DEFAULT_PREFERENCES.theme),
  system: systemTheme(),
  systemReduced: systemReducedMotion(),
  reduceMotionActive: false,
  update: (patch) => setPrefs(patch, true, 'reduceMotion' in patch ? true : undefined),
  reset: () => setPrefs({ ...DEFAULT_PREFERENCES }, true, false),
  cycleTheme: (): ThemePreference => {
    const cur: ThemePreference = useAppearance.getState().prefs.theme
    const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length]
    setPrefs({ theme: next }, true)
    return next
  },
}))

/** Apply the current store state to the document and persist it. */
function commit() {
  const s = useAppearance.getState()
  const systemReduced = systemReducedMotion()
  const system = systemTheme()
  const resolved = typeof document !== 'undefined' ? applyAppearance(s.prefs, { motionExplicit: s.motionExplicit, system, systemReduced }) : resolveTheme(s.prefs.theme, system)
  useAppearance.setState({ resolved, system, systemReduced, reduceMotionActive: resolveReduceMotion(s.prefs, s.motionExplicit, systemReduced) })
  writeStored({ v: 1, prefs: s.prefs, changedAt: s.changedAt, dirty: s.dirty, motionExplicit: s.motionExplicit })
}

/** A local change: apply, persist, schedule a save. `motionExplicit` updates the "user chose reduce motion" flag. */
function setPrefs(patch: Partial<UserPreferences>, local: boolean, motionExplicit?: boolean) {
  const s = useAppearance.getState()
  const prefs = normalizePreferences({ ...s.prefs, ...patch })
  useAppearance.setState(local ? { prefs, motionExplicit: motionExplicit ?? s.motionExplicit, changedAt: Date.now(), dirty: true } : { prefs })
  commit()
  if (local) scheduleSave()
}

// ---------------- server sync ----------------
let saveTimer: ReturnType<typeof setTimeout> | undefined
let saving = false

function signedIn(): boolean {
  return useSession.getState().status === 'ready'
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveNow(), SAVE_DEBOUNCE_MS)
}

/** PUT the current preferences if there are unsaved local changes and a signed-in user. */
export async function saveNow(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = undefined
  const s = useAppearance.getState()
  if (!s.dirty || !signedIn()) return
  if (saving) return scheduleSave()
  saving = true
  const sentAt = s.changedAt
  try {
    await api.savePreferences(s.prefs)
    // only clear the flag if nothing changed while the request was in flight
    if (useAppearance.getState().changedAt === sentAt) {
      useAppearance.setState({ dirty: false })
      commit()
    }
  } catch {
    /* offline or signed out: stays dirty and is retried on the next change or session start */
  } finally {
    saving = false
  }
}

/** Reconcile with the server copy: the newer side wins. */
export async function syncWithServer(): Promise<void> {
  let res: PreferencesResponse
  try {
    res = await api.preferences()
  } catch {
    return
  }
  applyServer(res)
  if (useAppearance.getState().dirty) await saveNow()
}

/** Adopt a server response unless the local copy has unsaved changes newer than it. Exported for tests. */
export function applyServer(res: PreferencesResponse) {
  const s = useAppearance.getState()
  if (res.updatedAt === null) return // never saved on the server: keep what this device has
  if (s.dirty && s.changedAt > res.updatedAt) return // local is newer; saveNow pushes it
  useAppearance.setState({ prefs: normalizePreferences(res.preferences), changedAt: res.updatedAt, dirty: false })
  commit()
}

// ---------------- bootstrap ----------------
let started = false

/** Apply the stored appearance, follow OS changes, sync with the session, install Ctrl+Shift+L. Idempotent. */
export function initAppearance() {
  if (started) return
  started = true
  commit()

  const onSystemChange = () => commit()
  media('(prefers-color-scheme: light)')?.addEventListener?.('change', onSystemChange)
  media('(prefers-reduced-motion: reduce)')?.addEventListener?.('change', onSystemChange)

  // another tab changed the appearance
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    const st = readStored()
    if (!st) return
    useAppearance.setState({ prefs: st.prefs, changedAt: st.changedAt, dirty: st.dirty, motionExplicit: st.motionExplicit })
    commit()
  })

  let syncedUser: string | undefined
  const onSession = (s: ReturnType<typeof useSession.getState>) => {
    if (s.status === 'ready' && s.user && s.user.id !== syncedUser) {
      syncedUser = s.user.id
      void syncWithServer()
    } else if (s.status === 'anon') syncedUser = undefined
  }
  useSession.subscribe(onSession)
  onSession(useSession.getState())

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      const next = useAppearance.getState().cycleTheme()
      toast(`Theme: ${THEME_LABEL[next]}${next === 'system' ? ` (${useAppearance.getState().resolved})` : ''}`)
    }
  })
}

export const themeLabel = (t: ThemePreference) => THEME_LABEL[t]

/** 'auto' when reduce motion is active, for JS-driven scrolling (CSS scroll-behavior doesn't cover it). */
export const scrollBehavior = (): ScrollBehavior => (typeof document !== 'undefined' && document.documentElement.dataset.reduceMotion === 'true' ? 'auto' : 'smooth')
