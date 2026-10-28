/// <reference lib="webworker" />
/**
 * Runs the speech model off the main thread: the page asks for it with `load`, then sends
 * audio with `run`. One model stays resident. `log` messages go to the page's diagnostics.
 */
import { env, pipeline, Tensor } from '@huggingface/transformers'
import type { ModelSpec } from './models'

env.allowLocalModels = false

export type ToWorker =
  | { t: 'load'; id: number; spec: ModelSpec }
  | { t: 'run'; id: number; spec: ModelSpec; input: Float32Array; options: Record<string, unknown> }

export type FromWorker =
  | { t: 'progress'; id: number; loaded: number; total: number }
  | { t: 'ok'; id: number; result?: unknown }
  | { t: 'err'; id: number; message: string }
  | { t: 'log'; id: number; msg: string; data?: unknown }

let loaded: { specId: string; pipe: Promise<any> } | null = null

const post = (m: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m)
const log = (msg: string, data?: unknown) => post({ t: 'log', id: 0, msg, data })
const ms = (t0: number) => Math.round(performance.now() - t0)

self.addEventListener('error', (e) => log('uncaught', { message: e.message, file: e.filename, line: e.lineno }))
self.addEventListener('unhandledrejection', (e) => log('unhandledrejection', { reason: String(e.reason) }))

/** What this worker runs on, sent once: it can differ from the page (WebGPU in workers, threads). */
function describe() {
  const onnx = (env.backends as any)?.onnx
  log('environment', {
    transformers: env.version,
    ort: onnx?.versions,
    wasm: { numThreads: onnx?.wasm?.numThreads, simd: onnx?.wasm?.simd, proxy: onnx?.wasm?.proxy, wasmPaths: onnx?.wasm?.wasmPaths },
    webgpu: { inWorker: !!(navigator as any).gpu, powerPreference: onnx?.webgpu?.powerPreference },
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
  })
}
let described = false

function get(spec: ModelSpec, onProgress?: (loaded: number, total: number) => void) {
  if (loaded?.specId === spec.id) return loaded.pipe
  if (loaded) void loaded.pipe.then((p) => p.dispose?.()).catch(() => {})
  if (!described) {
    described = true
    describe()
  }
  const t0 = performance.now()
  // each file once as it starts and as it's done, not every chunk
  const files = new Set<string>()
  const pipe = pipeline(spec.task, spec.repo, {
    device: spec.device,
    dtype: spec.dtype as any,
    progress_callback: (p: any) => {
      if (p.status === 'progress_total') onProgress?.(p.loaded, p.total)
      else if ((p.status === 'initiate' || p.status === 'done') && !files.has(p.status + p.file)) {
        files.add(p.status + p.file)
        log(`file ${p.status}`, { file: p.file, ms: ms(t0) })
      } else if (p.status === 'ready') log('pipeline ready', { ms: ms(t0) })
    },
  })
  pipe.then(
    (p) => log('model ready', { spec: spec.id, ms: ms(t0), device: p.model?.sessions && Object.keys(p.model.sessions), config: p.model?.config?.model_type }),
    (e) => log('model failed', { spec: spec.id, ms: ms(t0), error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }),
  )
  pipe.catch(() => loaded?.pipe === pipe && (loaded = null))
  loaded = { specId: spec.id, pipe }
  return pipe
}

/**
 * Whisper's own language guess: one decoder step after <|startoftranscript|>, read off the
 * language tokens. transformers.js would otherwise assume English for multilingual models.
 */
async function detectLanguage(pipe: any, audio: Float32Array): Promise<string | undefined> {
  const gc = pipe.model.generation_config
  if (!gc?.is_multilingual || !gc.lang_to_id) return undefined
  let t0 = performance.now()
  const { input_features } = await pipe.processor(audio)
  log('features', { ms: ms(t0), dims: input_features?.dims })
  t0 = performance.now()
  const start = new Tensor('int64', BigInt64Array.from([BigInt(gc.decoder_start_token_id)]), [1, 1])
  const { logits } = await pipe.model({ input_features, decoder_input_ids: start })
  const row: ArrayLike<number> = logits.data ?? (await logits.getData())
  let best: string | undefined
  let score = -Infinity
  for (const [tok, id] of Object.entries(gc.lang_to_id as Record<string, number>)) {
    if (row[id] > score) {
      score = row[id]
      best = tok
    }
  }
  log('language', { ms: ms(t0), language: best, score: Number.isFinite(score) ? score : String(score) })
  return best?.replace(/^<\|(.*)\|>$/, '$1')
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data
  try {
    if (m.t === 'load') {
      await get(m.spec, (l, total) => post({ t: 'progress', id: m.id, loaded: l, total }))
      post({ t: 'ok', id: m.id })
    } else {
      const pipe = await get(m.spec)
      const options = { ...m.options }
      // language: 'auto' asks for detection first; the result says what was heard
      if (options.language === 'auto') options.language = await detectLanguage(pipe, m.input)
      const t0 = performance.now()
      const result = await pipe(m.input, options)
      log('transcribed', { ms: ms(t0), seconds: m.input.length / 16_000, chars: String(result?.text ?? '').length })
      post({ t: 'ok', id: m.id, result: { ...result, language: options.language } })
    }
  } catch (err) {
    log('failed', { op: m.t, error: err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}`.slice(0, 1500) : String(err) })
    post({ t: 'err', id: m.id, message: err instanceof Error ? err.message : String(err) })
  }
}
