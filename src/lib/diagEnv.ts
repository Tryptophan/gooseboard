import { hasWebGPU, isMobile } from '../ai/device'
import { CACHE_NAME, whisperSpec } from '../ai/models'
import { diagSection } from './diag'

/**
 * The diagnostics sections about what the app runs on: the browser and device, WebGPU,
 * WebAssembly, audio, storage, and the service worker. Board and network sections live with
 * their own modules.
 */
export function registerEnvDiag() {
  diagSection('app', app)
  diagSection('browser', browser)
  diagSection('speech', speech)
  diagSection('webgpu', webgpu)
  diagSection('wasm', wasm)
  diagSection('audio', audio)
  diagSection('storage', storage)
}

async function app() {
  const sw = navigator.serviceWorker
  const reg = await sw?.getRegistration().catch(() => undefined)
  return {
    commit: __COMMIT__,
    mode: import.meta.env.MODE,
    base: import.meta.env.BASE_URL,
    origin: location.origin,
    secureContext: isSecureContext,
    crossOriginIsolated: self.crossOriginIsolated,
    standalone: matchMedia('(display-mode: standalone)').matches,
    visibility: document.visibilityState,
    serviceWorker: sw
      ? { controlled: !!sw.controller, active: reg?.active?.state ?? null, waiting: reg?.waiting?.state ?? null, installing: reg?.installing?.state ?? null }
      : 'unsupported',
  }
}

async function browser() {
  const nav = navigator as any
  const uad = nav.userAgentData
  const high = await uad?.getHighEntropyValues?.(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'formFactors', 'wow64']).catch(() => null)
  return {
    userAgent: navigator.userAgent,
    userAgentData: uad ? { brands: uad.brands, mobile: uad.mobile, platform: uad.platform, ...high } : null,
    languages: navigator.languages,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGB: nav.deviceMemory ?? null,
    jsHeap: (performance as any).memory ? { limitMB: Math.round((performance as any).memory.jsHeapSizeLimit / 1e6), usedMB: Math.round((performance as any).memory.usedJSHeapSize / 1e6) } : null,
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio, orientation: screen.orientation?.type },
    viewport: { w: innerWidth, h: innerHeight },
    pointer: { coarse: matchMedia('(pointer: coarse)').matches, maxTouchPoints: navigator.maxTouchPoints },
    online: navigator.onLine,
    connection: nav.connection ? { type: nav.connection.type, effectiveType: nav.connection.effectiveType, downlinkMbps: nav.connection.downlink, rttMs: nav.connection.rtt, saveData: nav.connection.saveData } : null,
    darkMode: matchMedia('(prefers-color-scheme: dark)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }
}

async function speech() {
  const spec = await whisperSpec()
  return { isMobile: isMobile(), hasWebGPU: await hasWebGPU(), chosen: spec }
}

const list = (s: Iterable<string> | undefined) => (s ? [...s].sort() : null)
function limits(l: any) {
  const out: Record<string, number> = {}
  // GPUSupportedLimits keeps its values as prototype getters, so Object.entries sees nothing
  for (let p = l; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) if (typeof l[k] === 'number') out[k] = l[k]
  }
  return out
}
function info(a: any) {
  const i = a.info ?? {}
  return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, isFallbackAdapter: a.isFallbackAdapter ?? i.isFallbackAdapter, subgroupMinSize: i.subgroupMinSize, subgroupMaxSize: i.subgroupMaxSize }
}

async function webgpu() {
  const gpu = (navigator as any).gpu
  if (!gpu) return { available: false }
  const out: Record<string, unknown> = { available: true, preferredCanvasFormat: gpu.getPreferredCanvasFormat?.(), wgslLanguageFeatures: list(gpu.wgslLanguageFeatures) }
  for (const pref of ['high-performance', 'low-power', undefined] as const) {
    const key = pref ?? 'default'
    try {
      const a = await gpu.requestAdapter(pref ? { powerPreference: pref } : undefined)
      if (!a) {
        out[key] = null
        continue
      }
      const entry: Record<string, unknown> = { info: info(a), features: list(a.features) }
      if (key === 'default') {
        entry.limits = limits(a.limits)
        // a device proves the adapter works; ask for what ONNX Runtime asks for where it can
        try {
          const t0 = performance.now()
          const d = await a.requestDevice({ requiredFeatures: [...a.features].filter((f: string) => f === 'shader-f16' || f === 'timestamp-query') })
          entry.device = { ok: true, ms: Math.round(performance.now() - t0), features: list(d.features) }
          d.destroy()
        } catch (e) {
          entry.device = { ok: false, error: String(e) }
        }
      }
      out[key] = entry
    } catch (e) {
      out[key] = { error: String(e) }
    }
  }
  return out
}

/** Feature probes from wasm-feature-detect: tiny modules that validate only where the feature exists. */
const PROBES: Record<string, number[]> = {
  simd: [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11],
  threads: [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11],
  bulkMemory: [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 10, 14, 1, 12, 0, 65, 0, 65, 0, 65, 0, 252, 10, 0, 0, 11],
}
function wasm() {
  if (typeof WebAssembly === 'undefined') return { available: false }
  const out: Record<string, unknown> = { available: true }
  for (const [k, bytes] of Object.entries(PROBES)) {
    try {
      out[k] = WebAssembly.validate(new Uint8Array(bytes))
    } catch {
      out[k] = false
    }
  }
  out.jspi = 'Suspending' in WebAssembly
  out.sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined'
  out.crossOriginIsolated = self.crossOriginIsolated
  return out
}

async function audio() {
  const md = navigator.mediaDevices
  const mic = await navigator.permissions?.query({ name: 'microphone' as PermissionName }).then(
    (p) => p.state,
    (e) => `query failed: ${e}`,
  )
  const devices = await md?.enumerateDevices().catch(() => [])
  let context: unknown = null
  try {
    const ctx = new AudioContext()
    context = { sampleRate: ctx.sampleRate, state: ctx.state, baseLatency: ctx.baseLatency, audioWorklet: !!ctx.audioWorklet }
    void ctx.close()
  } catch (e) {
    context = { error: String(e) }
  }
  return {
    getUserMedia: !!md?.getUserMedia,
    micPermission: mic ?? 'unknown',
    inputs: devices?.filter((d) => d.kind === 'audioinput').length ?? null,
    audioContext: context,
    audioWorkletNode: typeof AudioWorkletNode !== 'undefined',
    offlineAudioContext: typeof OfflineAudioContext !== 'undefined',
  }
}

async function storage() {
  const est = await navigator.storage?.estimate?.().catch(() => null)
  const persisted = await navigator.storage?.persisted?.().catch(() => null)
  let caches_: unknown = 'unsupported'
  if (typeof caches !== 'undefined') {
    try {
      const names = await caches.keys()
      const models = names.includes(CACHE_NAME) ? await caches.open(CACHE_NAME) : null
      const files = models
        ? await Promise.all(
            (await models.keys()).map(async (r) => ({ url: r.url.replace(/^https:\/\/huggingface\.co/, ''), bytes: Number((await models.match(r))?.headers.get('content-length') ?? 0) })),
          )
        : []
      caches_ = { names: names.map((n) => n.replace(/[0-9a-f]{12}$/, '<version>')), models: files }
    } catch (e) {
      caches_ = { error: String(e) }
    }
  }
  const dbs = await (indexedDB as any).databases?.().catch(() => null)
  let local: number | null = null
  try {
    local = localStorage.length
  } catch {
    /* blocked */
  }
  return {
    usageMB: est?.usage != null ? +(est.usage / 1e6).toFixed(1) : null,
    quotaMB: est?.quota != null ? Math.round(est.quota / 1e6) : null,
    persisted,
    caches: caches_,
    indexedDB: dbs ? dbs.length : 'unknown',
    localStorageKeys: local,
    fileSystemAccess: 'showDirectoryPicker' in window,
    opfs: !!navigator.storage?.getDirectory,
  }
}
