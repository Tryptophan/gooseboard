import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages on the custom domain https://gooseboard.io/
// Override with VITE_BASE (e.g. "/gooseboard/" for a <user>.github.io project site).
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? (process.env.VITE_BASE ?? '/') : '/',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: true },
}))
