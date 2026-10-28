// How long the end-to-end desktop sync tests wait for a server they start to answer. A cold tsx compile on a loaded
// machine (several suites at once) can take minutes, so the wait is long and can be raised: PS_TEST_BOOT_MS.

export const DEFAULT_BOOT_MS = 180_000

/** PS_TEST_BOOT_MS when it is a positive number, else three minutes. */
export function bootWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PS_TEST_BOOT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BOOT_MS
}

/** Setup hooks boot a cloud (and a desktop, and sign up) inside one hook: the boot wait plus a minute for the rest. */
export function hookTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(90_000, bootWaitMs(env) + 60_000)
}
