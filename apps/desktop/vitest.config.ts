import { defineConfig } from 'vitest/config'

// Electron itself is never started here: only the modules that don't import it (datadir, clipboard, logs, proc).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
