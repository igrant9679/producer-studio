import { defineConfig } from 'vitest/config'

// Electron itself is never started here: only the modules that don't import it (datadir, clipboard, logs, proc,
// backup, build-info, engine-host, health, shell-settings, tray, …) and the build's plain functions (scripts/release.mjs).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
