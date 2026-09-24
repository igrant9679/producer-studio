import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API = process.env.PS_API_URL ?? 'http://localhost:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/r': { target: API, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
  test: { environment: 'jsdom' },
} as never)
