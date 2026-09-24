// Locate the Claude Code CLI and probe it (version, supported flags, sign-in state).
// Search order: the path from Settings, the Claude desktop app's bundled CLI (%APPDATA%\Claude\claude-code\<ver>),
// the MSIX (Microsoft Store) package cache, ~/.local/bin, then PATH (`where` / `which`).
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ClaudeSource = 'settings' | 'desktop-bundle' | 'msix' | 'local-bin' | 'path'

export interface ClaudeInstall {
  path: string
  source: ClaudeSource
}

/** Filesystem/env seam so detection order can be unit-tested. */
export interface DetectDeps {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  exists(p: string): boolean
  readdir(p: string): string[]
  which(cmd: string): string[]
}

export const realDeps = (): DetectDeps => ({
  env: process.env,
  platform: process.platform,
  home: os.homedir(),
  exists: (p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  },
  readdir: (p) => {
    try {
      return fs.readdirSync(p)
    } catch {
      return []
    }
  },
  which: () => [],
})

/** Compare dotted versions numerically ("2.1.280" > "2.1.99"); non-numeric parts sort last. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1))
  const pb = b.split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

function bundleDirs(d: DetectDeps): Array<{ dir: string; source: ClaudeSource }> {
  const out: Array<{ dir: string; source: ClaudeSource }> = []
  const appData = d.env.APPDATA || path.join(d.home, 'AppData', 'Roaming')
  out.push({ dir: path.join(appData, 'Claude', 'claude-code'), source: 'desktop-bundle' })
  const localAppData = d.env.LOCALAPPDATA || path.join(d.home, 'AppData', 'Local')
  const pkgRoot = path.join(localAppData, 'Packages')
  for (const pkg of d.readdir(pkgRoot).filter((n) => /^Claude_/i.test(n)).sort()) {
    out.push({ dir: path.join(pkgRoot, pkg, 'LocalCache', 'Roaming', 'Claude', 'claude-code'), source: 'msix' })
  }
  return out
}

/** Every candidate in priority order (existing files only). */
export function claudeCandidates(configured: string | undefined, d: DetectDeps = realDeps()): ClaudeInstall[] {
  const win = d.platform === 'win32'
  const exe = win ? 'claude.exe' : 'claude'
  const out: ClaudeInstall[] = []
  const add = (p: string, source: ClaudeSource) => {
    if (p && d.exists(p) && !out.some((c) => c.path.toLowerCase() === p.toLowerCase())) out.push({ path: p, source })
  }
  if (configured?.trim()) add(configured.trim(), 'settings')
  if (win) {
    for (const { dir, source } of bundleDirs(d)) {
      const versions = d.readdir(dir).filter((v) => d.exists(path.join(dir, v, exe)))
      versions.sort((a, b) => compareVersions(b, a))
      for (const v of versions) add(path.join(dir, v, exe), source)
    }
  }
  add(path.join(d.home, '.local', 'bin', exe), 'local-bin')
  if (!win) add(path.join(d.home, '.claude', 'local', 'claude'), 'local-bin')
  for (const p of d.which('claude')) add(p, 'path')
  return out
}

function whichSync(cmd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const tool = process.platform === 'win32' ? 'where' : 'which'
    execFile(tool, [cmd], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([])
      resolve(
        String(stdout)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(l))),
      )
    })
  })
}

/**
 * Pick the install to use: the configured path always wins; otherwise the newest version, ties broken by the
 * search order (desktop bundle, MSIX, ~/.local/bin, PATH).
 */
export function pickClaude(candidates: ClaudeInstall[], versionOf: (p: string) => string | undefined): ClaudeInstall | null {
  if (!candidates.length) return null
  if (candidates[0].source === 'settings') return candidates[0]
  const ranked = candidates.map((c, i) => ({ c, i, v: versionOf(c.path) ?? '0' }))
  ranked.sort((a, b) => compareVersions(b.v, a.v) || a.i - b.i)
  return ranked[0].c
}

/** Best Claude CLI on this machine, or null. A configured path that doesn't exist falls back to auto-detect. */
export async function findClaude(configured?: string): Promise<ClaudeInstall | null> {
  const d = realDeps()
  const onPath = await whichSync('claude')
  const candidates = claudeCandidates(configured, { ...d, which: () => onPath })
  if (candidates[0]?.source === 'settings') return candidates[0]
  const versions = new Map<string, string>()
  await Promise.all(
    candidates.map(async (c) => {
      // bundled installs carry their version in the folder name; others are asked (cached per path + mtime)
      const fromDir = c.path.match(/claude-code[\\/](\d+\.\d+\.\d+[^\\/]*)[\\/]/i)?.[1]
      versions.set(c.path, fromDir ?? (await binaryVersion(c.path)))
    }),
  )
  return pickClaude(candidates, (p) => versions.get(p))
}

// Environment for every CLI run: drop variables that would attach it to another Claude Code session or redirect it
// away from the user's own subscription login (API keys, base URLs, host-session sockets).
const STRIP = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*|ANTHROPIC_.*|ELECTRON_RUN_AS_NODE)$/i

export function cliEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!STRIP.test(k) && v !== undefined) env[k] = v
  env.DISABLE_AUTOUPDATER = '1'
  env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1'
  return { ...env, ...extra }
}

/**
 * How to launch a CLI path: native binaries directly; a JS entry (tests) or an npm `claude.cmd` shim (resolved to its
 * cli.js, since .cmd files can't be spawned without a shell) with this process's Node binary.
 */
export function spawnable(bin: string, args: string[]): { file: string; args: string[]; env: Record<string, string> } {
  let js = /\.(m?js|cjs)$/i.test(bin) ? bin : undefined
  if (!js && /\.cmd$/i.test(bin)) {
    const cli = path.join(path.dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    if (fs.existsSync(cli)) js = cli
  }
  if (!js) return { file: bin, args, env: {} }
  return { file: process.execPath, args: [js, ...args], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} }
}

function execText(bin: string, argv: string[], timeoutMs = 15000): Promise<{ code: number; out: string }> {
  const { file, args, env } = spawnable(bin, argv)
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, env: cliEnv(process.env, env), maxBuffer: 4 * 1024 * 1024, cwd: os.tmpdir() }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : -1) : 0
      resolve({ code, out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}` })
    })
  })
}

export interface AuthStatus {
  loggedIn: boolean
  authMethod?: string
  email?: string
  subscriptionType?: string
  orgName?: string
  raw?: string
}

/** Parse `claude auth status` output (JSON; older versions print text). */
export function parseAuthStatus(out: string): AuthStatus {
  const a = out.indexOf('{')
  const b = out.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(out.slice(a, b + 1)) as Record<string, unknown>
      if (typeof j.loggedIn === 'boolean') {
        const s = (k: string) => (typeof j[k] === 'string' && j[k] ? (j[k] as string) : undefined)
        return { loggedIn: j.loggedIn, authMethod: s('authMethod'), email: s('email'), subscriptionType: s('subscriptionType'), orgName: s('orgName') }
      }
    } catch {
      /* fall through to text */
    }
  }
  const loggedIn = /logged in|authenticated/i.test(out) && !/not logged in|not authenticated|expired/i.test(out)
  return { loggedIn, raw: out.trim().split(/\r?\n/).slice(0, 3).join(' · ').slice(0, 200) }
}

interface BinaryInfo {
  version: string
  flags: Set<string>
  mtimeMs: number
}

const binaryCache = new Map<string, BinaryInfo>()

/** Version and supported flags of a CLI binary (cached per path + mtime). */
export async function binaryInfo(bin: string): Promise<BinaryInfo> {
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(bin).mtimeMs
  } catch {
    /* keep 0 */
  }
  const hit = binaryCache.get(bin)
  if (hit && hit.mtimeMs === mtimeMs) return hit
  const [v, h] = await Promise.all([execText(bin, ['--version']), execText(bin, ['--help'])])
  const version = v.out.match(/\d+\.\d+\.\d+[^\s]*/)?.[0] ?? 'unknown'
  const flags = new Set(h.out.match(/--[a-z][a-z-]+/g) ?? [])
  // hidden-but-supported flags we rely on (present since 1.x)
  if (flags.has('--system-prompt')) flags.add('--system-prompt-file')
  const info = { version, flags, mtimeMs }
  if (v.code === 0) binaryCache.set(bin, info)
  return info
}

const versionCache = new Map<string, { mtimeMs: number; version: string }>()

/** Just `--version` (cheaper than binaryInfo when ranking candidates). */
export async function binaryVersion(bin: string): Promise<string> {
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(bin).mtimeMs
  } catch {
    /* keep 0 */
  }
  const hit = binaryCache.get(bin) ?? versionCache.get(bin)
  if (hit && hit.mtimeMs === mtimeMs) return hit.version
  const v = await execText(bin, ['--version'])
  const version = v.out.match(/\d+\.\d+\.\d+[^\s]*/)?.[0] ?? '0'
  if (v.code === 0) versionCache.set(bin, { mtimeMs, version })
  return version
}

export async function authStatus(bin: string): Promise<AuthStatus> {
  const r = await execText(bin, ['auth', 'status'], 20000)
  return parseAuthStatus(r.out)
}
