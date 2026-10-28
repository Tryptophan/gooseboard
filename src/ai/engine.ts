import { diag } from '../lib/diag'
import type { ModelSpec } from './models'
import type { FromWorker, ToWorker } from './worker'

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  onProgress?(loaded: number, total: number): void
  onAlive?(stage: string, ms: number): void
}

/**
 * A run is given up as hung when the worker goes this long without finishing a stage. Slow
 * devices get longer: up to 25 times the time this one takes to compute features (plain
 * JavaScript, so it tracks the device's speed), and three times its slowest stage so far.
 */
const QUIET_MS = 60_000
const PER_FEATURES_MS = 25

type Msg = ToWorker extends infer M ? (M extends ToWorker ? Omit<M, 'id'> : never) : never

/** Main-thread handle on the model worker, shared by every board in this tab. */
class Engine {
  constructor(private label = 'engine') {}

  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private seq = 0
  /** the model the worker holds */
  private ready: { id: string; p: Promise<void> } | null = null

  /** the longest a stage of a run has taken on this device */
  private slowest = 0

  private send(msg: Msg, transfer: Transferable[] = [], onProgress?: Pending['onProgress'], onAlive?: Pending['onAlive']): Promise<unknown> {
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
        if (m.t === 'alive') return p.onAlive?.(m.stage, m.ms)
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
      this.pending.set(id, { resolve, reject, onProgress, onAlive })
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

  /** Fails, and restarts the worker, if the run stops making progress (see QUIET_MS). */
  async run<T>(spec: ModelSpec, input: Float32Array, options: Record<string, unknown>): Promise<T> {
    await this.load(spec)
    const t0 = performance.now()
    const n = input.length
    let quiet = Math.max(QUIET_MS, 3 * this.slowest)
    let timer: ReturnType<typeof setTimeout> | undefined
    let reject!: (e: Error) => void
    const hung = new Promise<never>((_, r) => (reject = r))
    const watch = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        diag(this.label, 'run timed out', { samples: n, quietMs: quiet, ms: Math.round(performance.now() - t0) })
        // rejected before reset() rejects the run with "stopped", so this is the error the caller sees
        reject(new Error('the speech model stopped responding'))
        this.reset()
      }, quiet)
    }
    const alive = (stage: string, ms: number) => {
      if (stage !== 'token') {
        this.slowest = Math.max(this.slowest, ms)
        diag(this.label, `run ${stage}`, { ms })
      }
      if (stage === 'features') quiet = Math.max(quiet, PER_FEATURES_MS * ms)
      watch()
    }
    diag(this.label, 'run', { spec: spec.id, samples: n, quietMs: quiet })
    watch()
    const out = this.send({ t: 'run', spec, input, options }, [input.buffer], undefined, alive)
    try {
      const r = await Promise.race([out, hung])
      diag(this.label, 'ran', { samples: n, ms: Math.round(performance.now() - t0) })
      return r as T
    } catch (e) {
      diag(this.label, 'run failed', { samples: n, ms: Math.round(performance.now() - t0), error: e })
      throw e
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
