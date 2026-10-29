// "Copy diagnostics" and opt-in crash reports (D-14). Diagnostics are plain text for a support request: versions, how
// the engine runs, paths, the tool check, the shell's settings, crash reports kept on this computer, and the last lines
// of the logs, with anything secret-looking taken out (tokens, keys, cookies, passwords, emails). Crash reports are
// Electron's own minidumps, kept locally only when the person turns them on; nothing is ever uploaded (the endpoint is
// an owner item). No Electron here, so it can be tested on its own.
import fs from 'node:fs'
import path from 'node:path'

const RULES: Array<[RegExp, string]> = [
  // device tokens, session cookies, the per-launch secret header, bearer tokens
  [/\bpsd_[A-Za-z0-9_-]{8,}/g, 'psd_[redacted]'],
  [/(ps_session=)[^;\s"']+/gi, '$1[redacted]'],
  [/(x-desktop-secret["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[redacted]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]'],
  // provider keys
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]'],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, 'AIza[redacted]'],
  // NAME=value / "name": "value" for anything called a secret, key, token or password
  [/(\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|_KEY)[A-Z0-9_]*\s*=\s*)\S+/g, '$1[redacted]'],
  [/("(?:[a-z]*(?:password|secret|token|apiKey|api_key)[a-z]*)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"'],
  // email addresses (personal data)
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // long opaque strings (base64 / hex keys) that slipped through
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, '[redacted]'],
]

export function redact(text: string): string {
  return RULES.reduce((t, [re, to]) => t.replace(re, to), text)
}

/** The last `n` lines of a log file (and of its rotated .1 when the current one is short), or [] when there's none. */
export function tailLog(file: string, n = 200): string[] {
  const read = (f: string) => {
    try {
      const buf = fs.readFileSync(f)
      // logs can be 10 MB: only the end is needed
      return buf.subarray(Math.max(0, buf.length - 512 * 1024)).toString('utf8').split(/\r?\n/)
    } catch {
      return []
    }
  }
  let lines = read(file).filter((l, i, a) => l || i < a.length - 1)
  if (lines.length < n) lines = [...read(`${file}.1`).filter(Boolean), ...lines]
  return lines.slice(-n)
}

export interface CrashDump {
  name: string
  at: number
  bytes: number
}

/** Minidumps under Electron's crash dumps folder (Crashpad keeps them a few levels down), newest first. */
export function listCrashDumps(dir: string, max = 20): CrashDump[] {
  const out: CrashDump[] = []
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory() && depth > 0) walk(p, depth - 1)
      else if (e.isFile() && /\.dmp$/i.test(e.name)) {
        const st = fs.statSync(p)
        out.push({ name: e.name, at: st.mtimeMs, bytes: st.size })
      }
    }
  }
  walk(dir, 3)
  return out.sort((a, b) => b.at - a.at).slice(0, max)
}

/** Electron crashReporter.start() options: local capture only, never uploaded; null when the person hasn't opted in. */
export function crashReporterOptions(optedIn: boolean): { uploadToServer: false; submitURL: string; compress: boolean } | null {
  return optedIn ? { uploadToServer: false, submitURL: '', compress: true } : null
}

export interface DiagnosticsInput {
  now: number
  app: Record<string, string | number | boolean | undefined>
  paths: Record<string, string | undefined>
  settings: Record<string, unknown>
  tools?: { ok: boolean; tools: Array<{ id: string; status: string; detail: string }> }
  crashes: CrashDump[]
  logs: Array<{ name: string; lines: string[] }>
}

/** The text "Copy diagnostics" puts on the clipboard. Everything passes through redact(). */
export function diagnosticsText(d: DiagnosticsInput): string {
  const kv = (o: Record<string, unknown>) =>
    Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  const out = [
    `Producer Studio diagnostics, ${new Date(d.now).toISOString()}`,
    '',
    'App',
    ...kv(d.app),
    '',
    'Paths',
    ...kv(d.paths),
    '',
    'Settings (this computer)',
    ...kv(d.settings),
    '',
    'Bundled tools',
    ...(d.tools ? d.tools.tools.map((t) => `  ${t.id}: ${t.status} · ${t.detail}`) : ['  (the engine didn’t answer)']),
    '',
    `Crash reports kept on this computer: ${d.crashes.length}`,
    ...d.crashes.map((c) => `  ${c.name} · ${new Date(c.at).toISOString()} · ${Math.round(c.bytes / 1024)} KB`),
  ]
  for (const l of d.logs) out.push('', `Last ${l.lines.length} lines of ${l.name}`, ...l.lines.map((x) => `  ${x}`))
  return redact(out.join('\n'))
}
