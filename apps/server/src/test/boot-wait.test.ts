// The end-to-end desktop sync tests wait long enough for a slow machine, and the wait can be raised (D-18).
import { describe, expect, it } from 'vitest'
import { DEFAULT_BOOT_MS, bootWaitMs, hookTimeoutMs } from './boot-wait'
import { startCloud } from './desktop-harness'

describe('boot wait for the end-to-end sync tests (D-18)', () => {
  it('defaults to three minutes and follows PS_TEST_BOOT_MS', () => {
    expect(bootWaitMs({})).toBe(DEFAULT_BOOT_MS)
    expect(DEFAULT_BOOT_MS).toBe(180_000)
    expect(bootWaitMs({ PS_TEST_BOOT_MS: '600000' })).toBe(600_000)
    // nonsense falls back to the default instead of "wait 0 ms"
    for (const v of ['', '0', '-5', 'soon']) expect(bootWaitMs({ PS_TEST_BOOT_MS: v })).toBe(DEFAULT_BOOT_MS)
  })

  it('setup hooks get the boot wait plus room for the rest of the hook', () => {
    expect(hookTimeoutMs({})).toBe(DEFAULT_BOOT_MS + 60_000)
    expect(hookTimeoutMs({ PS_TEST_BOOT_MS: '600000' })).toBe(660_000)
    // never below the suite's old 90 s
    expect(hookTimeoutMs({ PS_TEST_BOOT_MS: '1000' })).toBe(90_000)
  })

  it('a cloud that does not answer in time gives up with a message that names the setting', async () => {
    const t0 = Date.now()
    const err = await startCloud({}, { bootMs: 1 }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/did not start within .* PS_TEST_BOOT_MS/)
    // it gave up at once rather than after the default wait
    expect(Date.now() - t0).toBeLessThan(30_000)
  })
})
