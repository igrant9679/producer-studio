// How the local engine is hosted (D-12). Packaged builds run it in an Electron utility process: the main process no
// longer needs ELECTRON_RUN_AS_NODE to start it, and the build can switch off the Node-mode switches (NODE_OPTIONS,
// --inspect) with fuses. Dev (the TypeScript server through tsx) runs it as a Node child as before, and so does a
// packaged build whose utility process didn't start (one fallback per launch, logged). PS_ENGINE_HOST=child|utility
// overrides. The engine's own Node children (TTS worker, renderer, Claude's MCP server) still run as Electron-as-Node,
// so the runAsNode fuse stays on (see scripts/release.mjs). No Electron here, so it can be tested on its own.

export type EngineHost = 'utility' | 'child'

export function engineHost(o: { packaged: boolean; env: NodeJS.ProcessEnv }): EngineHost {
  const v = o.env.PS_ENGINE_HOST
  if (v === 'child' || v === 'utility') return v
  return o.packaged ? 'utility' : 'child'
}

/** The engine's environment for a host: how it learns that its parent is gone, and whether it runs as Node. */
export function engineEnv(base: NodeJS.ProcessEnv, host: EngineHost): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.DESKTOP_PARENT_STDIN
  delete env.DESKTOP_PARENT_PORT
  if (host === 'child') {
    env.ELECTRON_RUN_AS_NODE = '1'
    // it exits when our end of its stdin closes
    env.DESKTOP_PARENT_STDIN = '1'
  } else {
    // a utility process must not see it: Electron would start as plain Node instead of a utility process. The engine
    // sets it again for its own Node children (child-env.ts).
    delete env.ELECTRON_RUN_AS_NODE
    // it stops when the main process asks over the parent port; Electron ends it when the main process goes away
    env.DESKTOP_PARENT_PORT = '1'
  }
  return env
}

/** Split `node [execArgv…] script [args…]` into what utilityProcess.fork takes: the script, its args, execArgv. */
export function utilityLaunch(serverArgs: string[]): { modulePath: string; args: string[]; execArgv: string[] } {
  // the script is the first argument that isn't an option or an option's value (--import <url>)
  const execArgv: string[] = []
  let i = 0
  while (i < serverArgs.length && serverArgs[i].startsWith('-')) {
    const a = serverArgs[i++]
    execArgv.push(a)
    if (!a.includes('=') && (a === '--import' || a === '--require' || a === '-r' || a === '--loader') && i < serverArgs.length) execArgv.push(serverArgs[i++])
  }
  if (i >= serverArgs.length) throw new Error('No engine script to start')
  return { modulePath: serverArgs[i], args: serverArgs.slice(i + 1), execArgv }
}

/** The message that asks a utility-process engine to shut down cleanly (apps/server/src/index.ts listens for it). */
export const STOP_MESSAGE = { type: 'stop' } as const
