import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages project site: https://<user>.github.io/gooseboard/
// Override with VITE_BASE (e.g. "/" for a custom domain).
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? (process.env.VITE_BASE ?? '/gooseboard/') : '/',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: true },
}))
