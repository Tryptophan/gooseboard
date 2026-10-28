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
  /** a run got past a stage (features, encoder, language, a token): the page's watchdog starts over */
  | { t: 'alive'; id: number; stage: string; ms: number }

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
 * One utterance (up to 30 s), with the language detected. The encoder is most of the work, so
 * it runs once, for both Whisper's language guess and the transcript; the pipeline would run it
 * again. `alive` is told as each stage, and each token, is done.
 */
async function transcribe(pipe: any, audio: Float32Array, task: unknown, alive: (stage: string, ms: number) => void) {
  const model = pipe.model
  const { input_features, encoder_outputs, language } = await encode(pipe, audio, alive)
  // generate() keeps only the inputs named here: let the encoder output through, so it isn't run again
  if (!model.forward_params.includes('encoder_outputs')) model.forward_params = [...model.forward_params, 'encoder_outputs']
  const t0 = performance.now()
  let tokens = 0
  const out = await model.generate({
    inputs: input_features,
    encoder_outputs,
    language,
    task,
    num_frames: Math.floor(audio.length / pipe.processor.feature_extractor.config.hop_length),
    streamer: { put: () => alive('token', ++tokens), end: () => {} },
  })
  const text: string = pipe.tokenizer.batch_decode(out, { skip_special_tokens: true })[0] ?? ''
  log('decoded', { ms: ms(t0), tokens })
  return { text, language }
}

/** Features and encoder output for up to 30 s of audio, and the language Whisper hears in it. */
async function encode(pipe: any, audio: Float32Array, alive: (stage: string, ms: number) => void) {
  const model = pipe.model
  const gc = model.generation_config
  let t0 = performance.now()
  const { input_features } = await pipe.processor(audio)
  alive('features', ms(t0))
  t0 = performance.now()
  const { encoder_outputs } = await model._prepare_encoder_decoder_kwargs_for_generation({
    inputs_tensor: input_features,
    model_inputs: { input_features },
    model_input_name: 'input_features',
    generation_config: gc,
  })
  alive('encoder', ms(t0))
  // transformers.js would otherwise assume English for multilingual models
  t0 = performance.now()
  const language = gc?.is_multilingual && gc.lang_to_id ? await detectLanguage(model, input_features, encoder_outputs) : undefined
  alive('language', ms(t0))
  return { input_features, encoder_outputs, language }
}

/** Whisper's own language guess: one decoder step after <|startoftranscript|>, read off the language tokens. */
async function detectLanguage(model: any, input_features: unknown, encoder_outputs: unknown): Promise<string | undefined> {
  const gc = model.generation_config
  const t0 = performance.now()
  const start = new Tensor('int64', BigInt64Array.from([BigInt(gc.decoder_start_token_id)]), [1, 1])
  const { logits } = await model({ input_features, encoder_outputs, decoder_input_ids: start })
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
      const alive = (stage: string, n: number) => post({ t: 'alive', id: m.id, stage, ms: n })
      const t0 = performance.now()
      // language: 'auto' asks for detection too; the result says what was heard. Longer audio is
      // chunked by the pipeline.
      let result
      if (m.options.language === 'auto' && !m.options.chunk_length_s) result = await transcribe(pipe, m.input, m.options.task, alive)
      else {
        const options: Record<string, unknown> = { ...m.options, streamer: { put: () => alive('token', 0), end: () => {} } }
        // longer than one window: the language from the first 30 s
        if (options.language === 'auto') options.language = (await encode(pipe, m.input.subarray(0, 30 * 16_000), alive)).language
        result = { ...(await pipe(m.input, options)), language: options.language }
      }
      log('transcribed', { ms: ms(t0), seconds: m.input.length / 16_000, chars: String(result?.text ?? '').length })
      post({ t: 'ok', id: m.id, result })
    }
  } catch (err) {
    log('failed', { op: m.t, error: err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}`.slice(0, 1500) : String(err) })
    post({ t: 'err', id: m.id, message: err instanceof Error ? err.message : String(err) })
  }
}
