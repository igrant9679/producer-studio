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
  // defaults to 1 s — `src/test-setup.ts` raises that one, and explains why it is not enough.
  // A trustworthy full run needs `--maxWorkers=2` (or `--no-file-parallelism`) on a busy box:
  // a few render-heavy tests race their assertions when workers compete for CPU.
  test: { environment: 'jsdom', testTimeout: 20_000, setupFiles: ['./src/test-setup.ts'] },
} as never)
