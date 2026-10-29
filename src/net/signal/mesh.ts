import { sha256, toHex, Transport, type Endpoint } from './core'

/**
 * Signaling over the data channels we already have. Every open channel to another browser (board
 * links, and the QR bootstrap of ./qrlink) is a hop: y-webrtc's batches are flooded across them,
 * so anyone already connected can introduce new peers without a relay or tracker, which is how
 * devices on a LAN with no internet keep finding each other. Each message carries an id (dropped
 * when seen before) and a hop budget. Topics travel hashed: a peer relaying for a board it isn't
 * on must not learn the room name, which is also that board's password.
 */

export type MeshMsg =
  // a signaling batch: id, hashed topic, batch, hops left
  | { i: string; h: string; b: unknown[]; n: number }
  // liveness probe and its answer (see probe)
  | { p: 'ping' | 'pong'; i: string }

export interface MeshChannel {
  send(m: MeshMsg): void
  /** the y-webrtc connection this rides on, if any (see probe) */
  conn?: unknown
  /** the profile id on the other end, once known */
  user?: string
}

/** enough to be introduced through one peer in between, with one to spare */
const HOPS = 3

const topicHash = (topic: string) => sha256('gooseboard-mesh:' + topic).then(toHex)

export class MeshSignal extends Transport {
  private channels = new Set<MeshChannel>()
  private hashes = new Map<string, Promise<string>>()
  private byHash = new Map<string, string>()
  private seen = new Set<string>()
  private pongs = new Map<string, Set<MeshChannel>>()
  private watchers = new Set<() => void>()

  endpoints(): Endpoint[] {
    return [{ url: `${this.channels.size} link${this.channels.size === 1 ? '' : 's'}`, open: this.channels.size > 0 }]
  }

  resume() {}

  protected join(topic: string) {
    const h = topicHash(topic)
    this.hashes.set(topic, h)
    void h.then((x) => this.topics.has(topic) && this.byHash.set(x, topic))
  }

  protected leave(topic: string) {
    void this.hashes.get(topic)?.then((x) => this.byHash.delete(x))
    this.hashes.delete(topic)
  }

  protected send(topic: string, batch: unknown[]) {
    void this.hashes.get(topic)?.then((h) => {
      const i = crypto.randomUUID()
      this.mark(i)
      this.flood({ i, h, b: batch, n: HOPS })
    })
  }

  /** Adds a channel as a hop; returns its remover. */
  add(ch: MeshChannel): () => void {
    this.channels.add(ch)
    this.changed()
    return () => {
      if (this.channels.delete(ch)) this.changed()
    }
  }

  /** Call when a channel learns who is on its other end. */
  identified() {
    this.watchers.forEach((w) => w())
  }

  /** Users at the far end of a channel, other than through `except`. */
  hasUser(user: string, except?: MeshChannel) {
    for (const c of this.channels) if (c !== except && c.user === user) return true
    return false
  }

  watch(w: () => void) {
    this.watchers.add(w)
    return () => void this.watchers.delete(w)
  }

  receive(from: MeshChannel, m: MeshMsg) {
    if ('p' in m) {
      if (m.p === 'ping') from.send({ p: 'pong', i: m.i })
      else this.pongs.get(m.i)?.add(from)
      return
    }
    if (typeof m.i !== 'string' || typeof m.h !== 'string' || !Array.isArray(m.b) || !this.mark(m.i)) return
    const topic = this.byHash.get(m.h)
    if (topic) this.deliver(topic, m.b)
    if (m.n > 1) this.flood({ ...m, n: Math.min(m.n, HOPS) - 1 }, from)
  }

  /**
   * Asks every channel to answer within `ms`, and resolves to the y-webrtc connections that did.
   * A phone returning from the background uses this to keep the links that survived (see dropAll):
   * on a LAN with no internet they are the only way back to everyone else.
   */
  probe(ms: number): Promise<Set<unknown>> {
    const i = crypto.randomUUID()
    const got = new Set<MeshChannel>()
    this.pongs.set(i, got)
    this.channels.forEach((c) => c.send({ p: 'ping', i }))
    return new Promise((resolve) =>
      setTimeout(() => {
        this.pongs.delete(i)
        resolve(new Set([...got].map((c) => c.conn).filter(Boolean)))
      }, ms),
    )
  }

  private flood(m: MeshMsg, except?: MeshChannel) {
    this.channels.forEach((c) => c !== except && c.send(m))
  }

  private mark(id: string) {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!)
    return true
  }

  private changed() {
    this.statusChanged()
    this.watchers.forEach((w) => w())
  }
}
