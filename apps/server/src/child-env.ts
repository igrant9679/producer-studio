// Secrets the Electron main process hands the desktop server, and the environment every child process gets.
// DESKTOP_SECRET opens a full local session and DESKTOP_SECRET_KEY decrypts the cloud device token and the saved AI
// keys, so neither may reach anything we spawn: ffmpeg, the HyperFrames renderer, the TTS worker, the Claude CLI (and
// the user's hooks), VoiceStudio's Python and its engines, the sign-in terminal. The server entry moves them from
// process.env into memory before anything starts, and childEnv() strips them again wherever an environment is built.

const HELD = ['DESKTOP_SECRET', 'DESKTOP_SECRET_KEY'] as const
export type HeldSecret = (typeof HELD)[number]

const held: Partial<Record<HeldSecret, string>> = {}

/** Move the desktop secrets out of process.env into memory. Idempotent; a later value in the environment replaces the held one. */
export function takeDesktopSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of HELD) {
    const v = env[k]
    if (v === undefined) continue
    if (v) held[k] = v
    else delete held[k]
    delete env[k]
  }
}

/** A held desktop secret (taken from the environment on first use if the entry point hasn't done it yet). */
export function desktopSecret(name: HeldSecret): string | undefined {
  takeDesktopSecrets()
  return held[name]
}

/**
 * Environment for a child process: `base` (default: this process's) plus `extra`, never the desktop secrets. Inside
 * Electron (the desktop engine in a utility process, whose environment can't carry ELECTRON_RUN_AS_NODE) the program
 * at process.execPath is the app itself, so children started with it (the TTS worker, the renderer, Claude's MCP
 * server) get ELECTRON_RUN_AS_NODE=1 to run as Node instead of opening another app. Others ignore it.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env, extra: NodeJS.ProcessEnv = {}, inElectron = Boolean(process.versions.electron)): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra }
  for (const k of HELD) delete env[k]
  if (inElectron && env.ELECTRON_RUN_AS_NODE === undefined) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}
