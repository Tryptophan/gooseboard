import type { ModelSpec } from './models'
import type { FromWorker, ToWorker } from './worker'

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  onProgress?(loaded: number, total: number): void
}

/** Main-thread handle on the model worker, shared by every board in this tab. */
type Msg = ToWorker extends infer M ? (M extends ToWorker ? Omit<M, 'id'> : never) : never

class Engine {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private seq = 0
  /** the model the worker holds */
  private ready: { id: string; p: Promise<void> } | null = null

  private send(msg: Msg, transfer: Transferable[] = [], onProgress?: Pending['onProgress']): Promise<unknown> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data
        const p = this.pending.get(m.id)
        if (!p) return
        if (m.t === 'progress') return p.onProgress?.(m.loaded, m.total)
        this.pending.delete(m.id)
        if (m.t === 'ok') p.resolve(m.result)
        else p.reject(new Error(m.message))
      }
    }
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
      this.worker!.postMessage({ ...msg, id } as ToWorker, transfer)
    })
  }

  /** Downloads (first time) and initialises a model. Concurrent callers share one load. */
  load(spec: ModelSpec, onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.ready?.id === spec.id) return this.ready.p
    const p = this.send({ t: 'load', spec }, [], onProgress).then(() => {})
    p.catch(() => this.ready?.p === p && (this.ready = null))
    this.ready = { id: spec.id, p }
    return p
  }

  /** With `timeoutMs`, a run that hasn't answered by then fails, and the worker is restarted. */
  async run<T>(spec: ModelSpec, input: Float32Array, options: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    await this.load(spec)
    const out = this.send({ t: 'run', spec, input, options }, [input.buffer])
    if (!timeoutMs) return (await out) as T
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // rejected before reset() rejects `out` with "stopped", so this is the error the caller sees
        reject(new Error('the speech model stopped responding'))
        this.reset()
      }, timeoutMs)
    })
    try {
      return (await Promise.race([out, late])) as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** Frees the model and GPU memory, and cancels a download in progress. */
  reset() {
    this.worker?.terminate()
    this.worker = null
    this.pending.forEach((p) => p.reject(new Error('stopped')))
    this.pending.clear()
    this.ready = null
  }
}

export const engine = new Engine()
