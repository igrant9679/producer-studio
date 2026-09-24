import type { EaseName, Keyframe } from './types'

let counter = 0
/** Short unique id; collision-safe enough for client-generated ids within one project. */
export function uid(prefix = 'i'): string {
  counter = (counter + 1) % 1_000_000
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`
}

export const EPS = 1e-6

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
