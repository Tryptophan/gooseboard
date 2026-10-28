/** Shared pieces of the serverless signaling transports (see ./index.ts). */

export interface Endpoint {
  url: string
  open: boolean
}

/** Captured before installSignaling() patches the global. */
export const NativeWebSocket = globalThis.WebSocket

export const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/**
 * Every message reaches us once per relay/tracker that carried it (and the same handshake can
 * arrive over both transports). y-webrtc can't take an SDP answer twice, so drop repeats.
 * Its payloads are encrypted with a fresh IV each time, so identical text means the same message.
 */
const seen = new Set<string>()
function firstTime(data: unknown) {
  const k = typeof data === 'string' ? data : JSON.stringify(data)
  if (seen.has(k)) return false
  seen.add(k)
  if (seen.size > 5000) seen.delete(seen.values().next().value!)
  return true
}

export interface Sink {
  open(): void
  close(): void
  message(m: unknown): void
}

/**
 * One broadcast transport speaking y-webrtc's signaling protocol: messages published to a
 * topic reach everyone else subscribed to it. Subclasses move batches over the wire.
 */
export abstract class Transport {
  private sinks = new Set<Sink>()
  private queues = new Map<string, unknown[]>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  protected topics = new Set<string>()

  constructor(private onStatus: () => void) {}

  abstract endpoints(): Endpoint[]
  /** reconnects every relay/tracker now (see Wire.kick) */
  abstract resume(): void
  protected abstract join(topic: string): void
  protected abstract leave(topic: string): void
  /** sends one batch (a JSON-serialisable array) to everyone else on the topic */
  protected abstract send(topic: string, batch: unknown[]): void

  get up() {
    return this.endpoints().some((e) => e.open)
  }

  attach(s: Sink) {
    this.sinks.add(s)
    if (this.up) s.open()
  }
  detach(s: Sink) {
    this.sinks.delete(s)
  }

  subscribe(topic: string) {
    if (this.topics.has(topic)) return
    this.topics.add(topic)
    this.join(topic)
  }
  unsubscribe(topic: string) {
    if (this.topics.delete(topic)) this.leave(topic)
  }

  /** y-webrtc emits one message per ICE candidate: batch them to stay under relay rate limits. */
  publish(topic: string, data: unknown) {
    const q = this.queues.get(topic) ?? []
    q.push(data)
    this.queues.set(topic, q)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const all = [...this.queues]
      this.queues.clear()
      for (const [t, batch] of all) if (this.topics.has(t)) this.send(t, batch)
    }, 60)
  }

  protected deliver(topic: string, batch: unknown) {
    if (!Array.isArray(batch) || !this.topics.has(topic)) return
    for (const data of batch) if (firstTime(data)) this.sinks.forEach((s) => s.message({ type: 'publish', topic, data }))
  }

  /** call whenever an endpoint opens or closes */
  protected statusChanged() {
    const up = this.up
    this.sinks.forEach((s) => (up ? s.open() : s.close()))
    this.onStatus()
  }
}

/** Reconnecting WebSocket used by the transports (exponential backoff, capped at a minute). */
export class Wire {
  open = false
  private ws: WebSocket | null = null
  private tries = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly url: string,
    private on: { open(): void; message(data: string): void; close(): void },
  ) {
    this.connect()
  }

  private connect() {
    let ws: WebSocket
    try {
      ws = new NativeWebSocket(this.url)
    } catch {
      return this.retry()
    }
    this.ws = ws
    ws.onopen = () => {
      this.tries = 0
      this.open = true
      this.on.open()
    }
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this.on.message(e.data)
    }
    ws.onclose = () => {
      const was = this.open
      this.open = false
      this.ws = null
      if (was) this.on.close()
      this.retry()
    }
  }

  private retry() {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, Math.min(60_000, 2_000 * 2 ** this.tries++))
  }

  /** Drops the socket (it may be dead while still claiming to be open) and dials again now, skipping any backoff. */
  kick() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.tries = 0
    const ws = this.ws
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null
      ws.close()
      this.ws = null
    }
    if (this.open) {
      this.open = false
      this.on.close()
    }
    this.connect()
  }

  send(msg: unknown) {
    if (this.open && this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg))
  }
}
