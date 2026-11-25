import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API = process.env.PS_API_URL ?? 'http://localhost:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // /r/:token share pages are SPA routes; the page fetches /api/share/:token.
      '/api': { target: API, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: 'hidden', chunkSizeWarningLimit: 1500 },
  // Slower machines (and several suites at once) push some render-heavy tests past the 5 s default.
  // `testTimeout` is vitest's own; testing-library's `findBy*`/`waitFor` budget is separate and
  // defaults to 1 s — `src/test-setup.ts` raises that one. The races that made full runs flaky on a
  // busy box were fixed on 2026-11-06 (see `src/test-setup.ts`).
  // Half the cores at most: each worker holds a jsdom, and with other builds running on the same machine three of them
  // ran it out of memory on 2026-11-24 (a worker died "JavaScript heap out of memory" and the run reported errors).
  test: { environment: 'jsdom', testTimeout: 20_000, setupFiles: ['./src/test-setup.ts'], maxWorkers: '50%' },
} as never)
