import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Voice notes' Silero VAD loads its model, audio worklet, and ONNX Runtime's wasm at runtime:
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

/**
 * Offline app: writes the built files (and a version hashed from their contents) into the
 * service worker's BUILD, which precaches them. Voice notes' wasm and model stay on demand.
 */
function precache(): Plugin {
  const skip = /\.(map|wasm)$|^vad\/|^(og\.png|sitemap\.xml|robots\.txt|CNAME|stream-sw\.js)$/
  let outDir = 'dist'
  return {
    name: 'precache',
    apply: 'build',
    configResolved(c) {
      outDir = join(c.root, c.build.outDir)
    },
    writeBundle() {
      const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => relative(outDir, join(d.parentPath, d.name)).split('\\').join('/'))
        .filter((f) => !skip.test(f))
        .sort()
      const hash = createHash('sha256')
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)))
      const sw = join(outDir, 'stream-sw.js')
      const src = readFileSync(sw, 'utf8')
      if (!src.includes('const BUILD = null')) throw new Error('stream-sw.js: BUILD placeholder missing')
      writeFileSync(sw, src.replace('const BUILD = null', `const BUILD = ${JSON.stringify({ version: hash.digest('hex').slice(0, 12), files })}`))
    },
  }
}

/** The commit being built, with "+" when the tree has changes, for the diagnostics in Help. */
function commit(): string {
  try {
    const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    return execSync('git status --porcelain', { encoding: 'utf8' }).trim() ? `${head}+` : head
  } catch {
    return 'unknown'
  }
}

// GitHub Pages on the custom domain https://gooseboard.io/
// Override with VITE_BASE (e.g. "/gooseboard/" for a <user>.github.io project site).
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? (process.env.VITE_BASE ?? '/') : '/',
  plugins: [react(), vadAssets(), precache()],
  build: { target: 'es2022', sourcemap: true },
  define: { __COMMIT__: JSON.stringify(commit()) },
}))
