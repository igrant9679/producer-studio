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
  test: { environment: 'jsdom', testTimeout: 20_000 },
} as never)
