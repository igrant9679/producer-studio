import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_PREFERENCES, type UserPreferences } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { STORAGE_KEY, applyAppearance, applyServer, readStored, resolveReduceMotion, resolveTheme, saveNow, systemTheme, useAppearance } from './appearance'
import { useSession } from './session'

// jsdom has no matchMedia: a controllable stand-in
const mq = { light: false, reduce: false }
const listeners = new Set<() => void>()
function installMatchMedia() {
  window.matchMedia = ((q: string) => ({
    media: q,
    get matches() {
      return q.includes('prefers-color-scheme: light') ? mq.light : q.includes('prefers-reduced-motion') ? mq.reduce : false
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const root = () => document.documentElement
const attrs = () => ({
  theme: root().dataset.theme,
  pref: root().dataset.themePref,
  accent: root().dataset.accent,
  density: root().dataset.density,
  motion: root().dataset.reduceMotion,
  scale: root().style.getPropertyValue('--ui-scale'),
})
const prefs = (p: Partial<UserPreferences> = {}): UserPreferences => ({ ...DEFAULT_PREFERENCES, ...p })

beforeEach(() => {
  installMatchMedia()
  mq.light = false
  mq.reduce = false
  localStorage.clear()
  useAppearance.getState().reset()
  useAppearance.setState({ dirty: false, changedAt: 0, motionExplicit: false })
})
afterEach(() => vi.restoreAllMocks())

describe('theme resolution', () => {
  it('follows prefers-color-scheme for "system" and ignores it otherwise', () => {
    expect(systemTheme()).toBe('dark')
    mq.light = true
    expect(systemTheme()).toBe('light')
    expect(resolveTheme('system')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('light', 'dark')).toBe('light')
    expect(resolveTheme('system', 'dark')).toBe('dark')
  })

  it('reduces motion when chosen, or when the OS asks and the user has not chosen', () => {
    expect(resolveReduceMotion(prefs(), false, false)).toBe(false)
    expect(resolveReduceMotion(prefs({ reduceMotion: true }), true, false)).toBe(true)
    expect(resolveReduceMotion(prefs(), false, true)).toBe(true)
    // the user explicitly turned it off: the OS setting no longer forces it
    expect(resolveReduceMotion(prefs(), true, true)).toBe(false)
  })
})

describe('applyAppearance', () => {
  it('sets the attributes and the text scale on <html>', () => {
    const t = applyAppearance(prefs({ theme: 'light', accent: 'teal', density: 'compact', textSize: 'xl', reduceMotion: true }))
    expect(t).toBe('light')
    expect(attrs()).toEqual({ theme: 'light', pref: 'light', accent: 'teal', density: 'compact', motion: 'true', scale: '1.25' })
    applyAppearance(prefs({ textSize: 'sm' }), { system: 'dark' })
    expect(attrs()).toMatchObject({ theme: 'dark', pref: 'system', accent: 'coral', density: 'comfortable', motion: 'false', scale: '0.9' })
  })

  it('tells the desktop shell which native theme to use', () => {
    const setNativeTheme = vi.fn(() => Promise.resolve(true))
    ;(window as unknown as { producerDesktop?: unknown }).producerDesktop = { setNativeTheme }
    try {
      applyAppearance(prefs({ theme: 'light' }))
      applyAppearance(prefs({ theme: 'light', accent: 'pink' }))
      applyAppearance(prefs({ theme: 'system' }))
      expect(setNativeTheme.mock.calls).toEqual([['light'], ['system']])
    } finally {
      delete (window as unknown as { producerDesktop?: unknown }).producerDesktop
    }
  })
})

describe('store + localStorage', () => {
  it('applies changes instantly and persists them', () => {
    useAppearance.getState().update({ theme: 'light', accent: 'violet' })
    expect(attrs()).toMatchObject({ theme: 'light', accent: 'violet' })
    const stored = readStored()!
    expect(stored.prefs).toEqual(prefs({ theme: 'light', accent: 'violet' }))
    expect(stored.dirty).toBe(true)
    expect(stored.changedAt).toBeGreaterThan(0)
  })

  it('tolerates corrupt or partial storage', () => {
    localStorage.setItem(STORAGE_KEY, '{nope')
    expect(readStored()).toBeUndefined()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ prefs: { theme: 'sepia', textSize: 'lg', accent: 42 } }))
    expect(readStored()!.prefs).toEqual(prefs({ textSize: 'lg' }))
  })

  it('cycles system -> dark -> light -> system', () => {
    const s = useAppearance.getState()
    expect([s.cycleTheme(), s.cycleTheme(), s.cycleTheme()]).toEqual(['dark', 'light', 'system'])
  })

  it('re-resolves "system" when the OS theme changes', async () => {
    const { initAppearance } = await import('./appearance')
    initAppearance()
    expect(root().dataset.theme).toBe('dark')
    mq.light = true
    listeners.forEach((cb) => cb())
    expect(root().dataset.theme).toBe('light')
    expect(useAppearance.getState().resolved).toBe('light')
  })

  it('reset restores the defaults', () => {
    useAppearance.getState().update({ theme: 'light', textSize: 'xl', reduceMotion: true })
    useAppearance.getState().reset()
    expect(useAppearance.getState().prefs).toEqual(prefs())
    expect(useAppearance.getState().motionExplicit).toBe(false)
  })
})

describe('server sync', () => {
  it('adopts the server copy when it is newer than the last local change', () => {
    useAppearance.setState({ prefs: prefs({ theme: 'dark' }), changedAt: 1000, dirty: true })
    applyServer({ preferences: prefs({ theme: 'light', accent: 'blue' }), updatedAt: 2000 })
    expect(useAppearance.getState()).toMatchObject({ prefs: prefs({ theme: 'light', accent: 'blue' }), dirty: false })
    expect(root().dataset.theme).toBe('light')
  })

  it('keeps newer unsaved local changes, and ignores a server that never saved', () => {
    useAppearance.setState({ prefs: prefs({ accent: 'pink' }), changedAt: 5000, dirty: true })
    applyServer({ preferences: prefs({ accent: 'teal' }), updatedAt: 4000 })
    expect(useAppearance.getState().prefs.accent).toBe('pink')
    applyServer({ preferences: prefs(), updatedAt: null })
    expect(useAppearance.getState().prefs.accent).toBe('pink')
  })

  it('saves dirty changes only when signed in', async () => {
    const save = vi.spyOn(api, 'savePreferences').mockResolvedValue({ preferences: prefs({ theme: 'light' }), updatedAt: Date.now() })
    useAppearance.getState().update({ theme: 'light' })
    useSession.setState({ status: 'anon' })
    await saveNow()
    expect(save).not.toHaveBeenCalled()
    useSession.setState({ status: 'ready' })
    await saveNow()
    expect(save).toHaveBeenCalledWith(prefs({ theme: 'light' }))
    expect(useAppearance.getState().dirty).toBe(false)
    useSession.setState({ status: 'loading' })
  })
})

describe('public/appearance-boot.js', () => {
  const code = fs.readFileSync(path.resolve(__dirname, '../../public/appearance-boot.js'), 'utf8')
  const boot = () => new Function(code)()
  const cases: Array<[string, Partial<UserPreferences>, { light?: boolean; reduce?: boolean; explicit?: boolean }]> = [
    ['defaults, dark OS', {}, {}],
    ['system follows a light OS', { theme: 'system' }, { light: true }],
    ['explicit light, compact, xl, teal', { theme: 'light', density: 'compact', textSize: 'xl', accent: 'teal' }, {}],
    ['OS reduced motion, not chosen', {}, { reduce: true }],
    ['OS reduced motion, user turned it off', { reduceMotion: false }, { reduce: true, explicit: true }],
  ]
  for (const [name, p, env] of cases) {
    it(`matches appearance.ts: ${name}`, () => {
      mq.light = !!env.light
      mq.reduce = !!env.reduce
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, prefs: prefs(p), changedAt: 1, dirty: false, motionExplicit: !!env.explicit }))
      root().removeAttribute('data-theme')
      boot()
      const fromBoot = attrs()
      applyAppearance(prefs(p), { motionExplicit: !!env.explicit })
      expect(fromBoot).toEqual(attrs())
    })
  }

  it('falls back to defaults without storage', () => {
    localStorage.removeItem(STORAGE_KEY)
    boot()
    expect(attrs()).toEqual({ theme: 'dark', pref: 'system', accent: 'coral', density: 'comfortable', motion: 'false', scale: '1' })
  })
})
