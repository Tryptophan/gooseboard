import { hasWebGPU, isMobile } from './device'

/**
 * The speech model: Whisper Tiny from the Hugging Face hub (onnx-community). transformers.js
 * keeps the weights in the browser's Cache API, so it downloads once.
 */
export type Device = 'webgpu' | 'wasm'
export type Dtype = 'fp32' | 'fp16' | 'q8' | 'q4'

export interface ModelSpec {
  /** stable key, e.g. "whisper-tiny-webgpu" */
  id: string
  task: 'automatic-speech-recognition'
  repo: string
  device: Device
  dtype: Record<string, Dtype>
  /** approximate download in MB */
  mb: number
}

export const CACHE_NAME = 'transformers-cache'

/** ONNX file sizes in MB from the hub (checked 2026-10-27); config and tokenizer add ~3 MB. */
const base = { task: 'automatic-speech-recognition' as const, repo: 'onnx-community/whisper-tiny' }
const WHISPER: Record<Device, ModelSpec> = {
  webgpu: { ...base, id: 'whisper-tiny-webgpu', device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, mb: 33 + 87 + 3 },
  wasm: { ...base, id: 'whisper-tiny-wasm', device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, mb: 10 + 31 + 3 },
}

export async function whisperSpec(): Promise<ModelSpec> {
  return !isMobile() && (await hasWebGPU()) ? WHISPER.webgpu : WHISPER.wasm
}

const SUFFIX: Record<Dtype, string> = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4' }
const onnxFiles = (m: ModelSpec) => Object.entries(m.dtype).map(([name, d]) => `/${m.repo}/resolve/main/onnx/${name}${SUFFIX[d]}.onnx`)

async function cachedUrls(): Promise<string[]> {
  if (typeof caches === 'undefined') return []
  try {
    const c = await caches.open(CACHE_NAME)
    return (await c.keys()).map((r) => r.url)
  } catch {
    return []
  }
}

/** true when every weight file of `m` is already in the browser cache */
export async function isDownloaded(m: ModelSpec): Promise<boolean> {
  const urls = await cachedUrls()
  return onnxFiles(m).every((f) => urls.some((u) => u.endsWith(f)))
}

/** Bytes of model files in the cache, from their Content-Length (reading the bodies would load them all). */
export async function cachedModelBytes(): Promise<number> {
  if (typeof caches === 'undefined') return 0
  try {
    const c = await caches.open(CACHE_NAME)
    let n = 0
    for (const r of await c.keys()) n += Number((await c.match(r))?.headers.get('content-length') ?? 0)
    return n
  } catch {
    return 0
  }
}

export async function deleteAllModels() {
  if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME)
}

export const formatMB = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`)
