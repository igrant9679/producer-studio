// Small formatting helpers shared by shell pages.
import type { JobKind } from '@producer/core'

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  if (d < 35) return `${Math.round(d / 7)} wk ago`
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: now - ts > 3e10 ? 'numeric' : undefined })
}

/** 75.4 -> "1:15", 3725 -> "1:02:05" */
export function formatDuration(sec: number | undefined): string {
  if (!sec || !isFinite(sec) || sec < 0) return '0:00'
  const t = Math.round(sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Source-time label with tenths: 12.34 -> "0:12.3" */
export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export function formatBytes(n: number | undefined): string {
  if (!n) return '—'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

/** 1920x1080 -> "16:9" */
export function aspectLabel(w: number, h: number): string {
  if (!w || !h) return '—'
  const g = gcd(w, h)
  const a = `${w / g}:${h / g}`
  const known: Record<string, string> = { '64:27': '21:9', '1:1': '1:1' }
  return known[a] ?? a
}

export function aspectFor(id: string): { width: number; height: number } {
  const map: Record<string, [number, number]> = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '4:3': [1440, 1080], '3:4': [1080, 1440], '21:9': [2560, 1080] }
  const [width, height] = map[id] ?? map['16:9']
  return { width, height }
}

export const JOB_LABELS: Record<JobKind, string> = {
  'asset.process': 'Processing media',
  'ai.transcribe': 'Transcribing',
  'ai.tts': 'Generating voiceover',
  'ai.produce.script': 'Writing script',
  'ai.produce.assemble': 'Assembling video',
  'export.render': 'Rendering export',
}

export function initials(name: string | undefined): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback for non-secure contexts.
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

export function absoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).toString()
  } catch {
    return url
  }
}

export function ssGet<T>(key: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}

export function ssSet(key: string, value: unknown) {
  try {
    if (value === undefined) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}
