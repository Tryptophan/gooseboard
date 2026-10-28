import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Voice notes' Silero VAD loads its model, audio worklet and ONNX Runtime's wasm at runtime:
 * served from /vad/ in dev and copied there in the build, so no CDN is involved.
 */
function vadAssets(): Plugin {
  const require = createRequire(import.meta.url)
  const vad = dirname(require.resolve('@ricky0123/vad-web/package.json'))
  // the onnxruntime-web that vad-web itself resolves (its dist/), so the wasm matches its JS
  const ort = dirname(createRequire(join(vad, 'package.json')).resolve('onnxruntime-web'))
  const files: Record<string, string> = {
    'silero_vad_v5.onnx': join(vad, 'dist/silero_vad_v5.onnx'),
    'vad.worklet.bundle.min.js': join(vad, 'dist/vad.worklet.bundle.min.js'),
    'ort-wasm-simd-threaded.mjs': join(ort, 'ort-wasm-simd-threaded.mjs'),
    'ort-wasm-simd-threaded.wasm': join(ort, 'ort-wasm-simd-threaded.wasm'),
  }
  const types: Record<string, string> = { onnx: 'application/octet-stream', js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm' }
  let base = '/'
  return {
    name: 'vad-assets',
    configResolved(c) {
      base = c.base
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0].replace(`${base}vad/`, '')
        if (!req.url?.startsWith(`${base}vad/`) || !name || !files[name]) return next()
        res.setHeader('Content-Type', types[name.split('.').pop()!])
        res.end(readFileSync(files[name]))
      })
    },
    generateBundle() {
      for (const [name, path] of Object.entries(files)) this.emitFile({ type: 'asset', fileName: `vad/${name}`, source: readFileSync(path) })
    },
  }
}

// GitHub Pages on the custom domain https://gooseboard.io/
// Override with VITE_BASE (e.g. "/gooseboard/" for a <user>.github.io project site).
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? (process.env.VITE_BASE ?? '/') : '/',
  plugins: [react(), vadAssets()],
  build: { target: 'es2022', sourcemap: true },
}))
