// Waiting for the local engine to answer at start-up. A warm start takes seconds, but the first start after installing
// can take minutes: Windows scans the engine's files as it loads them (a copy of the unpacked build took 2 min 4 s from
// launch to listening here, against ~30 s for one already scanned). So the wait follows the engine, not a fixed clock:
// it waits while the engine is still running, says it is slow after a while, and gives up only at a generous limit.
// No Electron here, so it can be tested on its own.

/** After this long the splash says the start is slow, and why. */
export const SLOW_AFTER_MS = 20_000
/** Gives up after this long, even with the engine still running. */
export const BOOT_LIMIT_MS = 5 * 60_000

export interface BootWaitDeps {
  /** The engine's exit code once it has exited, else null. */
  exitCode(): number | null
  /** One health probe: true when the engine answered. */
  probe(): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
  onSlow?(): void
}

export async function waitForEngine(d: BootWaitDeps, logFile: string, limitMs = BOOT_LIMIT_MS, slowAfterMs = SLOW_AFTER_MS): Promise<void> {
  const t0 = d.now()
  let slow = false
  while (d.now() - t0 < limitMs) {
    const code = d.exitCode()
    if (code !== null) throw new Error(`The local server exited during startup (code ${code}). See ${logFile}`)
    if (await d.probe()) return
    if (!slow && d.now() - t0 >= slowAfterMs) {
      slow = true
      d.onSlow?.()
    }
    await d.sleep(250)
  }
  throw new Error(`The local server did not start within ${Math.round(limitMs / 60_000)} minutes. See ${logFile}`)
}
