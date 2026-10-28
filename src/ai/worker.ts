/// <reference lib="webworker" />
/**
 * Runs the speech model off the main thread: the page asks for it with `load`, then sends
 * audio with `run`. One model stays resident.
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

let loaded: { specId: string; pipe: Promise<any> } | null = null

function get(spec: ModelSpec, onProgress?: (loaded: number, total: number) => void) {
  if (loaded?.specId === spec.id) return loaded.pipe
  if (loaded) void loaded.pipe.then((p) => p.dispose?.()).catch(() => {})
  const pipe = pipeline(spec.task, spec.repo, {
    device: spec.device,
    dtype: spec.dtype as any,
    progress_callback: (p: any) => p.status === 'progress_total' && onProgress?.(p.loaded, p.total),
  })
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
  const { input_features } = await pipe.processor(audio)
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
  return best?.replace(/^<\|(.*)\|>$/, '$1')
}

const post = (m: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m)

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
      const result = await pipe(m.input, options)
      post({ t: 'ok', id: m.id, result: { ...result, language: options.language } })
    }
  } catch (err) {
    post({ t: 'err', id: m.id, message: err instanceof Error ? err.message : String(err) })
  }
}
