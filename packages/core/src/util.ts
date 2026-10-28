import type { EaseName, Keyframe } from './types'

let counter = 0
/** Short unique id; collision-safe enough for client-generated ids within one project. */
export function uid(prefix = 'i'): string {
  counter = (counter + 1) % 1_000_000
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`
}

export const EPS = 1e-6

/**
 * Links for copies of items (duplicate, paste): copied clips that were linked are linked to each other under a new
 * group; a copy whose partner wasn't copied is linked to nothing.
 */
export function linkCopies(sources: Array<{ linkId?: string }>): (linkId: string | undefined) => string | undefined {
  const count = new Map<string, number>()
  for (const s of sources) if (s.linkId) count.set(s.linkId, (count.get(s.linkId) ?? 0) + 1)
  const fresh = new Map<string, string>()
  return (linkId) => {
    if (!linkId || (count.get(linkId) ?? 0) < 2) return undefined
    if (!fresh.has(linkId)) fresh.set(linkId, uid('l'))
    return fresh.get(linkId)
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function round(v: number, places = 3): number {
  const m = 10 ** places
  return Math.round(v * m) / m
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function ease(name: EaseName | undefined, t: number): number {
  const x = clamp(t, 0, 1)
  switch (name) {
    case 'easeIn':
      return x * x * x
    case 'easeOut':
      return 1 - (1 - x) ** 3
    case 'easeInOut':
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
    case 'hold':
      return x >= 1 ? 1 : 0
    default:
      return x
  }
}

/** Value of a keyframe track at local time t (seconds from item start). */
export function sampleKeyframes(kfs: Keyframe[] | undefined, t: number, fallback: number): number {
  if (!kfs || kfs.length === 0) return fallback
  if (kfs.length === 1) return kfs[0].value
  if (t <= kfs[0].t) return kfs[0].value
  const last = kfs[kfs.length - 1]
  if (t >= last.t) return last.value
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const p = span <= EPS ? 1 : (t - a.t) / span
      return lerp(a.value, b.value, ease(a.ease ?? 'linear', p))
    }
  }
  return last.value
}

/** Deterministic pseudo-random in [0,1) from a numeric seed (for grain/shake; render-safe). */
export function hash01(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

export function formatTimecode(sec: number, fps = 30): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const whole = Math.floor(s % 60)
  const f = Math.floor((s - Math.floor(s)) * fps)
  return `${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}:${String(f).padStart(2, '0')}`
}

export function snapToFrame(sec: number, fps: number): number {
  return Math.round(sec * fps) / fps
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
// numbers, %, deg, commas, slashes and spaces only: nothing that can close a declaration, attribute or tag
const FN_COLOR = /^(?:rgba?|hsla?)\(\s*[-+0-9.%,/\s]*(?:deg)?[-+0-9.%,/\s]*\)$/i
const NAMED_COLOR = /^[a-z]{3,20}$/i

/** True for a plain CSS colour: hex, rgb()/rgba()/hsl()/hsla() with numbers only, or a keyword (red, transparent). */
export function isSafeColor(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 64) return false
  const s = v.trim()
  return HEX_COLOR.test(s) || FN_COLOR.test(s) || NAMED_COLOR.test(s)
}

/**
 * A colour that is safe to put into CSS or an HTML attribute, else `fallback`. Project documents are user data
 * (and shared with the whole workspace), so every colour goes through this before it reaches markup.
 */
export function safeColor(v: unknown, fallback: string): string {
  return isSafeColor(v) ? v.trim() : fallback
}

/** A finite number for CSS, else `fallback` (document fields are typed, but stored documents are user data). */
export function cssNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}
