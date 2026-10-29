import { clear, createStore, del, delMany, entries, get, keys, set } from 'idb-keyval'
import { hashBlob } from '../lib/hash'
import type { GetReq, Meta } from './p2p'

/**
 * The transfer cache: every byte range this browser fetched over the network (streamed video
 * included), kept in IndexedDB as fixed-size chunks keyed by content hash, so a transfer picks
 * up where it stopped (after a reload, from another peer, or as a download), and a replay or
 * seek back plays from here. A chunk is kept only once it's complete (or it's the file's last).
 * Past CAP, the least recently used entries go first, never one in use. A complete entry is
 * hash-checked, then served to others like a synced copy.
 */
export const CHUNK = 1024 * 1024
const CAP = 2 * 1024 ** 3
const VERIFY_AFTER = 3000

export type Want = 'sync' | 'download'

export interface PartialEntry extends Meta {
  hash: string
  /** indexes of the chunks held */
  chunks: number[]
  bytes: number
  boards: string[]
  at: number
  verified?: boolean
  /** what the bytes are being fetched for, so an interrupted transfer can carry on */
  want?: Want
  /** where a download comes from, to offer resuming it */
  src?: { ownerId: string; ownerName: string; req: GetReq }
  /** the sender canceled it: never restarted on its own */
  canceledBy?: string
}

const metaStore = createStore('gooseboard-partial', 'meta')
const chunkStore = createStore('gooseboard-partial-chunks', 'chunks')
const chunkKey = (hash: string, i: number) => [hash, i]
const count = (size: number) => Math.max(1, Math.ceil(size / CHUNK))

type Listener = () => void

export class PartialCache {
  private map = new Map<string, PartialEntry>()
  private held = new Map<string, Set<number>>()
  private pins = new Map<string, number>()
  private verifying = new Map<string, ReturnType<typeof setTimeout>>()
  private total = 0
  private version = 0
  /** bumps only when the set of servable (complete, verified) entries changes */
  heldVersion = 0
  private listeners = new Set<Listener>()
  readonly ready: Promise<void>

  constructor() {
    this.ready = (async () => {
      for (const [k, e] of await entries<string, PartialEntry>(metaStore)) {
        this.map.set(k, e)
        this.held.set(k, new Set(e.chunks))
        this.total += e.bytes
      }
      // chunks written just before a close, with no record of them yet
      const orphans = (await keys<[string, number]>(chunkStore)).filter(([h, i]) => !this.held.get(h)?.has(i))
      if (orphans.length) await delMany(orphans, chunkStore)
    })()
      .catch(() => {})
      .then(() => {
        for (const e of this.map.values()) if (this.complete(e.hash) && !e.verified) this.verifySoon(e.hash)
        this.bump(true)
      })
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getVersion = () => this.version
  private bump(heldChanged = false) {
    if (heldChanged) this.heldVersion++
    this.version++
    this.listeners.forEach((l) => l())
  }

  entry(hash: string) {
    return this.map.get(hash)
  }
  list() {
    return [...this.map.values()]
  }

  /** Any bytes of it held. */
  has(hash: string) {
    return !!this.held.get(hash)?.size
  }

  complete(hash: string) {
    const e = this.map.get(hash)
    return !!e && this.held.get(hash)!.size === count(e.size)
  }

  hasChunk(hash: string, i: number) {
    return !!this.held.get(hash)?.has(i)
  }

  /** The first chunk held after `i`, if any. */
  nextHeld(hash: string, i: number): number | undefined {
    let best: number | undefined
    this.held.get(hash)?.forEach((j) => j > i && (best === undefined || j < best) && (best = j))
    return best
  }

  /** Marks `hash` in use (never evicted) until the returned function is called. */
  use(hash: string): () => void {
    this.pins.set(hash, (this.pins.get(hash) ?? 0) + 1)
    const e = this.map.get(hash)
    if (e) e.at = Date.now()
    let held = true
    return () => {
      if (!held) return
      held = false
      const n = (this.pins.get(hash) ?? 1) - 1
      if (n > 0) this.pins.set(hash, n)
      else this.pins.delete(hash)
    }
  }

  async chunk(hash: string, i: number): Promise<Uint8Array | null> {
    if (!this.hasChunk(hash, i)) return null
    const b = await get<Blob>(chunkKey(hash, i), chunkStore).catch(() => undefined)
    if (!b) {
      // gone from under us (storage cleared): forget it
      this.held.get(hash)?.delete(i)
      return null
    }
    return new Uint8Array(await b.arrayBuffer())
  }

  /** The whole file, pieced together from the chunks, once every one is held. */
  async blob(hash: string): Promise<Blob | null> {
    const e = this.map.get(hash)
    if (!e || !this.complete(hash)) return null
    const parts: Blob[] = []
    for (let i = 0; i < count(e.size); i++) {
      const b = await get<Blob>(chunkKey(hash, i), chunkStore).catch(() => undefined)
      if (!b) return null
      parts.push(b)
    }
    const out = new Blob(parts, { type: e.mime })
    return out.size === e.size ? out : null
  }

  /** A complete, verified copy that may be served to people on `board`. */
  async servable(hash: string, board: string): Promise<{ blob: Blob; e: PartialEntry } | null> {
    const e = this.map.get(hash)
    if (!e?.verified || !e.boards.includes(board)) return null
    const blob = await this.blob(hash)
    return blob ? { blob, e } : null
  }

  /** What to advertise to peers on `board`. */
  heldFor(board: string): string[] {
    return [...this.map.values()].filter((e) => e.verified && e.boards.includes(board) && this.complete(e.hash)).map((e) => e.hash)
  }

  /** The entry for `hash`, made (or remade, if the size changed) as needed. */
  ensure(hash: string, m: Meta, board: string): PartialEntry {
    let e = this.map.get(hash)
    if (e && e.size !== m.size) {
      void this.drop(hash)
      e = undefined
    }
    if (!e) {
      e = { hash, name: m.name, size: m.size, mime: m.mime, chunks: [], bytes: 0, boards: [board], at: Date.now() }
      this.map.set(hash, e)
      this.held.set(hash, new Set())
    } else {
      if (!e.boards.includes(board)) e.boards = [...e.boards, board]
      e.mime ||= m.mime
    }
    return e
  }

  /** Records what `hash` is fetched for (undefined: nothing; a stray fetch). */
  async setWant(hash: string, m: Meta, board: string, p: Pick<PartialEntry, 'want' | 'src' | 'canceledBy'>) {
    const e = this.ensure(hash, m, board)
    e.want = p.want
    e.src = p.src
    e.canceledBy = p.canceledBy
    await this.save(e)
    this.bump()
  }

  private save(e: PartialEntry) {
    e.chunks = [...this.held.get(e.hash)!]
    return set(e.hash, e, metaStore).catch(() => {})
  }

  /** Writes bytes arriving in order from `start` into chunks; the first one is skipped if it starts mid-chunk. */
  writer(hash: string, m: Meta, board: string) {
    this.ensure(hash, m, board)
    let idx = -1
    let buf: Uint8Array | null = null
    let fill = 0
    return {
      write: async (off: number, bytes: Uint8Array) => {
        let p = off
        let b = bytes
        while (b.length && p < m.size) {
          const i = Math.floor(p / CHUNK)
          const cs = i * CHUNK
          const ce = Math.min(cs + CHUNK, m.size)
          if (idx !== i) {
            buf = null
            if (p !== cs || this.hasChunk(hash, i)) {
              // can't complete this chunk (or it's held already): skip to the next one
              const n = Math.min(b.length, ce - p)
              p += n
              b = b.subarray(n)
              continue
            }
            idx = i
            buf = new Uint8Array(ce - cs)
            fill = 0
          }
          const n = Math.min(b.length, ce - p)
          buf!.set(b.subarray(0, n), p - cs)
          fill += n
          p += n
          b = b.subarray(n)
          if (fill === ce - cs) {
            const full = buf!
            buf = null
            idx = -1
            await this.put(hash, i, full)
          }
        }
      },
    }
  }

  private async put(hash: string, i: number, bytes: Uint8Array) {
    const e = this.map.get(hash)
    const held = this.held.get(hash)
    if (!e || !held || held.has(i)) return
    try {
      await set(chunkKey(hash, i), new Blob([bytes as BlobPart]), chunkStore)
    } catch {
      return // out of quota, most likely: this chunk is fetched again when needed
    }
    if (this.map.get(hash) !== e) return void del(chunkKey(hash, i), chunkStore).catch(() => {})
    held.add(i)
    e.bytes += bytes.length
    e.at = Date.now()
    this.total += bytes.length
    await this.save(e)
    if (this.complete(hash)) this.verifySoon(hash)
    if (this.total > CAP) await this.evict()
    this.bump()
  }

  /** Checks a complete entry against its hash unless whoever fetched it does first (see verified). */
  private verifySoon(hash: string) {
    clearTimeout(this.verifying.get(hash))
    this.verifying.set(
      hash,
      setTimeout(async () => {
        this.verifying.delete(hash)
        const e = this.map.get(hash)
        if (!e || e.verified || !this.complete(hash)) return
        const b = await this.blob(hash)
        if (b && (await hashBlob(b).catch(() => '')) === hash) await this.verified(hash)
        else if (this.map.get(hash) === e) await this.drop(hash)
      }, VERIFY_AFTER),
    )
  }

  /** The whole file matched its hash: servable from now on. */
  async verified(hash: string) {
    const e = this.map.get(hash)
    if (!e || e.verified || !this.complete(hash)) return
    e.verified = true
    await this.save(e)
    this.bump(true)
  }

  private async evict() {
    // entries waiting to be resumed go after stray ones
    const order = [...this.map.values()]
      .filter((e) => !this.pins.has(e.hash))
      .sort((a, b) => Number(!!(a.want || a.canceledBy)) - Number(!!(b.want || b.canceledBy)) || a.at - b.at)
    for (const e of order) {
      if (this.total <= CAP) break
      await this.drop(e.hash, false)
    }
  }

  async drop(hash: string, notify = true) {
    const e = this.map.get(hash)
    if (!e) return
    const held = this.held.get(hash)!
    this.map.delete(hash)
    this.held.delete(hash)
    this.total -= e.bytes
    await del(hash, metaStore).catch(() => {})
    await delMany([...held].map((i) => chunkKey(hash, i)), chunkStore).catch(() => {})
    if (notify) this.bump(!!e.verified)
  }

  /** Forgets every piece (synced files stay). Transfers fetch what they need again. */
  async clear() {
    await this.ready
    this.map.clear()
    this.held.clear()
    this.total = 0
    await clear(metaStore).catch(() => {})
    await clear(chunkStore).catch(() => {})
    this.bump(true)
  }

  stats() {
    let n = 0
    for (const e of this.map.values()) if (e.bytes) n++
    return { count: n, bytes: this.total }
  }
}
