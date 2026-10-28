import { defineConfig } from 'vitest/config'
import { hookTimeoutMs } from './src/test/boot-wait'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 90_000,
    // the desktop sync suites boot a cloud server in beforeAll (PS_TEST_BOOT_MS, see src/test/boot-wait.ts)
    hookTimeout: hookTimeoutMs(),
    pool: 'forks',
  },
})
