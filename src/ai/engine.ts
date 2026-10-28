import { diag } from '../lib/diag'
import type { ModelSpec } from './models'
import type { FromWorker, ToWorker } from './worker'

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  onProgress?(loaded: number, total: number): void
}

type Msg = ToWorker extends infer M ? (M extends ToWorker ? Omit<M, 'id'> : never) : never

/** Main-thread handle on a model worker. `engine` is the one every board in this tab shares. */
export class Engine {
  constructor(private label = 'engine') {}

  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private seq = 0
  /** the model the worker holds */
  private ready: { id: string; p: Promise<void> } | null = null

  private send(msg: Msg, transfer: Transferable[] = [], onProgress?: Pending['onProgress']): Promise<unknown> {
    if (!this.worker) {
      diag(this.label, 'worker start')
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      this.worker = worker
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data
        if (m.t === 'log') return diag(`${this.label}.worker`, m.msg, m.data)
        const p = this.pending.get(m.id)
        if (!p) return
        if (m.t === 'progress') return p.onProgress?.(m.loaded, m.total)
        this.pending.delete(m.id)
        if (m.t === 'ok') p.resolve(m.result)
        else p.reject(new Error(m.message))
      }
      // the worker failed to load or crashed (out of memory, say): nothing it was doing will answer
      worker.onerror = (e) => {
        diag(this.label, 'worker error', { message: e.message, file: e.filename, line: e.lineno })
        if (this.worker !== worker) return
        e.preventDefault()
        this.fail(new Error(`the speech model crashed${e.message ? `: ${e.message}` : ''}`))
      }
      worker.onmessageerror = () => diag(this.label, 'worker message error')
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
    const t0 = performance.now()
    diag(this.label, 'load', { spec: spec.id })
    // the download, logged at each quarter
    let quarter = -1
    const progress = (l: number, total: number) => {
      const q = total ? Math.floor((l / total) * 4) : -1
      if (q > quarter) {
        quarter = q
        diag(this.label, 'download', { loaded: l, total, ms: Math.round(performance.now() - t0) })
      }
      onProgress?.(l, total)
    }
    const p = this.send({ t: 'load', spec }, [], progress).then(() => void diag(this.label, 'loaded', { spec: spec.id, ms: Math.round(performance.now() - t0) }))
    p.catch((e) => {
      diag(this.label, 'load failed', { spec: spec.id, ms: Math.round(performance.now() - t0), error: e })
      if (this.ready?.p === p) this.ready = null
    })
    this.ready = { id: spec.id, p }
    return p
  }

  /** With `timeoutMs`, a run that hasn't answered by then fails, and the worker is restarted. */
  async run<T>(spec: ModelSpec, input: Float32Array, options: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    await this.load(spec)
    const t0 = performance.now()
    const n = input.length
    diag(this.label, 'run', { spec: spec.id, samples: n, timeoutMs })
    const out = this.send({ t: 'run', spec, input, options }, [input.buffer]).then(
      (r) => {
        diag(this.label, 'ran', { samples: n, ms: Math.round(performance.now() - t0) })
        return r
      },
      (e) => {
        diag(this.label, 'run failed', { samples: n, ms: Math.round(performance.now() - t0), error: e })
        throw e
      },
    )
    if (!timeoutMs) return (await out) as T
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // rejected before reset() rejects `out` with "stopped", so this is the error the caller sees
        diag(this.label, 'run timed out', { samples: n, timeoutMs })
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
    if (this.worker) diag(this.label, 'reset', { pending: this.pending.size })
    this.fail(new Error('stopped'))
  }

  private fail(e: Error) {
    this.worker?.terminate()
    this.worker = null
    this.pending.forEach((p) => p.reject(e))
    this.pending.clear()
    this.ready = null
  }

  /** What it holds right now, for diagnostics. */
  status() {
    return { worker: !!this.worker, model: this.ready?.id ?? null, pending: this.pending.size }
  }
}

export const engine = new Engine()
