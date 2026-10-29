import { createStore, get, set } from 'idb-keyval'
import { SMALL_FILE } from '../config'
import { canSavePicker } from '../lib/files'
import { Hasher } from '../lib/hash'
import type { Profile } from '../lib/storage'
import type { Mirror } from './mirror'
import { CanceledBy, type GetReq, type Handlers, type Meta, type P2P, type ReqHandle, type ReqState } from './p2p'
import { CHUNK, type PartialCache } from './partial'
import type { DirEntry } from './sources'
import { openStream, type Stream } from './streamSW'
import { PreviewCache } from './previewCache'
import { makePreview } from './thumbs'
import type { TransferStore } from './transfers'

const CONSOLIDATE_AT = 64 * 1024 * 1024
const listingStore = createStore('gooseboard-listings', 'listings')
/** an answer bigger than this came from a peer that sent the whole file: shrink it here */
const PREVIEW_BYTES = 1024 * 1024

export interface DownloadArgs {
  ownerId: string
  ownerName: string
  req: GetReq
  name: string
  size: number
}

export interface StreamHandlers {
  /** shown in the transfer list */
  name?: string
  peerName?: string
  onState?(s: ReqState): void
  /** a range failed (not called for ranges the player abandoned) */
  onError?(msg: string): void
}

export interface BlobOpts {
  onProgress?(done: number): void
  signal?: AbortSignal
  /** keep the copy in this browser (IndexedDB) whatever its size: syncing, not just opening */
  keep?: boolean
}

interface Fetched {
  blob: Blob
  hash?: string
}

/** A whole-file fetch that a preview and downloads of the same file share, so the bytes cross the wire once. */
export interface SharedFetch {
  result: Promise<Fetched>
  done: number
  state: ReqState
  watchers: Set<() => void>
}

interface Shared extends SharedFetch {
  refs: number
  ctl: AbortController
}

export interface Lease {
  fetch: SharedFetch
  release(): void
}

/** errors after which the cached pieces are dropped and the whole file is fetched once more */
const BAD_COPY = /^(verification failed|missing pieces)/

const fileKey = (ownerId: string, r: GetReq) => [ownerId, r.kind, r.key, r.path ?? '', r.hash ?? ''].join('\0')

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** User-facing operations on remote files: thumbnails, directory listings, previews, downloads. */
export class FileService {
  private previews = new PreviewCache()
  private shared = new Map<string, Shared>()

  constructor(
    private p2p: P2P,
    private self: Profile,
    private transfers: TransferStore,
    private mirror: Mirror,
    private board: string,
    private partial: PartialCache,
  ) {
    // downloads a reload or close cut off: offered again, to resume with a click (it ends in a save prompt)
    void partial.ready.then(() => {
      for (const e of partial.list()) if (e.want === 'download' && e.src && e.boards.includes(board)) this.offerResume(e.hash, `resume:${e.hash}`, e.canceledBy && `Canceled by ${e.canceledBy}`)
    })
  }

  /** Bytes of this file go through the transfer cache: a hashed file someone else holds. */
  private cacheable(ownerId: string, req: GetReq) {
    return req.op === 'file' && !!req.hash && ownerId !== this.self.id && !this.mirror.has(req.hash, this.board)
  }

  /** Shows a stopped download in Transfers with a Resume button; dismissing it forgets that it was wanted. */
  private offerResume(hash: string, id: string, why?: string) {
    const e = this.partial.entry(hash)
    if (!e?.src) return
    const src = e.src
    const args: DownloadArgs = { ownerId: src.ownerId, ownerName: src.ownerName, req: src.req, name: e.name, size: e.size }
    const t = {
      dir: 'down' as const, name: e.name, size: e.size, done: e.bytes, state: why ? ('canceled' as const) : ('interrupted' as const), error: why,
      peerName: src.ownerName,
      resume: () => {
        this.transfers.remove(id)
        void this.download(args)
      },
      cancel: () => {
        void this.partial.setWant(hash, e, this.board, {})
        this.transfers.remove(id)
      },
    }
    if (this.transfers.getSnapshot().some((x) => x.id === id)) this.transfers.patch(id, t)
    else this.transfers.add({ id, startedAt: e.at, ...t })
  }

  /**
   * Like P2P.request, but cache first: chunks held in the transfer cache are read from there,
   * and only the gaps are fetched, one after another, each from one source (written to the
   * cache as they arrive). Bytes reach `h.onData` in order from `req.from`, clipped to `req.to`.
   */
  private pull(ownerId: string, req: GetReq, h: Handlers, onNet?: (n: number) => void): ReqHandle {
    if (!this.cacheable(ownerId, req)) return this.p2p.request(ownerId, req, onNet ? { ...h, onData: (o, b) => (onNet(b.length), h.onData?.(o, b)) } : h)
    const pc = this.partial
    const hash = req.hash!
    let cur: ReqHandle | null = null
    let stopped = false
    const release = pc.use(hash)
    const run = async (): Promise<Meta | undefined> => {
      await pc.ready
      const e0 = pc.entry(hash)
      let meta: Meta | undefined = e0 && { name: e0.name, size: e0.size, mime: e0.mime }
      if (meta) h.onMeta?.(meta)
      let p = req.from ?? 0
      let active = false
      const end = () => Math.min(req.to ?? Infinity, meta?.size ?? Infinity)
      for (;;) {
        if (stopped) throw new Error('canceled')
        if (p >= end()) return meta
        const i = Math.floor(p / CHUNK)
        const b = await pc.chunk(hash, i)
        if (b) {
          if (!active) {
            active = true
            h.onState?.('active')
          }
          const piece = b.subarray(p - i * CHUNK, Math.min(b.length, end() - i * CHUNK))
          if (!piece.length) throw new Error('missing pieces')
          await h.onData?.(p, piece)
          p += piece.length
          continue
        }
        // a gap: fetch whole chunks of it, up to the next chunk held
        const next = pc.nextHeld(hash, i)
        let to = req.to === undefined ? undefined : Math.ceil(req.to / CHUNK) * CHUNK
        if (next !== undefined) to = Math.min(to ?? Infinity, next * CHUNK)
        if (to !== undefined && meta && to >= meta.size) to = undefined
        let w = meta ? pc.writer(hash, meta, this.board) : null
        let full = false
        const before = p
        const r = this.p2p.request(ownerId, { ...req, from: i * CHUNK, to }, {
          onState: h.onState,
          onMeta: (m) => {
            if (!meta?.mime) h.onMeta?.((meta = m))
            w ??= pc.writer(hash, m, this.board)
          },
          onData: async (off, bytes) => {
            if (full) return
            onNet?.(bytes.length)
            // peers on an older build ignore `to` and send the rest of the file: clip and stop them
            if (to !== undefined && off + bytes.length > to) bytes = bytes.subarray(0, to - off)
            await w?.write(off, bytes)
            const lo = Math.max(p, off)
            const hi = Math.min(off + bytes.length, end())
            if (hi > lo) {
              await h.onData?.(lo, bytes.subarray(lo - off, hi - off))
              p = hi
            }
            // past the end wanted, the chunk is still finished, so the cache keeps it
            if (to !== undefined && off + bytes.length >= to) {
              full = true
              r.cancel()
            }
          },
        })
        cur = r
        try {
          await r.done
        } catch (e) {
          if (!full) throw e
        } finally {
          cur = null
        }
        if (p === before) throw new Error('short read')
      }
    }
    const done = run().finally(release)
    done.catch(() => {})
    return {
      done,
      cancel: () => {
        stopped = true
        cur?.cancel()
      },
    }
  }

  /** Fills in `hash` for folder files someone already fetched, so holders can serve them too. */
  private withHash(req: GetReq): GetReq {
    if (req.op !== 'file' || req.hash || !req.alias) return req
    const hash = this.p2p.aliasHash(req.alias)
    return hash ? { ...req, hash } : req
  }

  /** Whole files are hashed as they arrive; a mismatch with the expected hash is an error. */
  private async verify(req: GetReq, hasher: Hasher | null): Promise<string | undefined> {
    if (!hasher) return undefined
    const got = await hasher.digest()
    if (req.hash && got !== req.hash) throw new Error('verification failed: content does not match')
    return got
  }

  async getBlob(ownerId: string, req: GetReq, onState?: (s: ReqState) => void, o: BlobOpts = {}): Promise<Blob> {
    return (await this.fetch(ownerId, req, onState, o)).blob
  }

  /** `raw`: past the transfer cache, held in memory (the second try after a bad pieced-together copy). */
  private async fetch(ownerId: string, req: GetReq, onState?: (s: ReqState) => void, o: BlobOpts = {}, raw = false): Promise<Fetched> {
    req = this.withHash(req)
    const cached = !raw && this.cacheable(ownerId, req)
    const parts: BlobPart[] = []
    let mime = ''
    let name = ''
    const hasher = req.op === 'file' ? new Hasher() : null
    const handlers: Handlers = {
      onMeta: (m) => {
        mime = m.mime
        name = m.name
      },
      onData: async (_o, b) => {
        // cached bytes are pieced together from the cache at the end, not held here
        if (!cached) parts.push(b as BlobPart)
        await hasher?.update(b)
        o.onProgress?.(hasher?.size ?? 0)
      },
      onState,
    }
    const h = cached ? this.pull(ownerId, req, handlers) : this.p2p.request(ownerId, req, handlers)
    o.signal?.addEventListener('abort', () => h.cancel())
    let blob: Blob | null
    let hash: string | undefined
    try {
      await h.done
      hash = await this.verify(req, hasher)
      blob = cached ? await this.partial.blob(req.hash!) : new Blob(parts, { type: mime })
      if (!blob) throw new Error('missing pieces')
    } catch (e) {
      if (!cached || !BAD_COPY.test((e as Error).message)) throw e
      await this.partial.drop(req.hash!)
      return this.fetch(ownerId, req, onState, o, true)
    }
    if (cached) await this.partial.verified(hash!)
    // anything small we fetched (incl. folder files someone opened), or synced on purpose, becomes servable by us
    if (hash && (blob.size <= SMALL_FILE || o.keep)) {
      await this.mirror.put(hash, { name, mime, board: this.board, alias: req.alias }, { blob }, { persist: o.keep })
      // kept for good now: the pieces aren't needed (read the copy back, it outlives them)
      if (cached && this.mirror.entry(hash)?.kind === 'blob') {
        blob = (await this.mirror.get(hash)) ?? blob
        await this.partial.drop(hash)
      }
    }
    return { blob, hash }
  }

  /**
   * Joins (or starts) the whole-file fetch for `req`. Call release() when done with it; the
   * fetch is canceled once nobody holds it.
   */
  acquire(ownerId: string, req: GetReq): Lease {
    const k = fileKey(ownerId, req)
    let sh = this.shared.get(k)
    if (!sh) {
      const s: Shared = { done: 0, state: 'connecting', refs: 0, ctl: new AbortController(), watchers: new Set(), result: null! }
      const notify = () => s.watchers.forEach((w) => w())
      s.result = this.fetch(
        ownerId,
        { ...req, op: 'file' },
        (st) => {
          s.state = st
          notify()
        },
        {
          signal: s.ctl.signal,
          onProgress: (d) => {
            s.done = d
            notify()
          },
        },
      )
      s.result.catch(() => this.shared.get(k) === s && this.shared.delete(k))
      this.shared.set(k, s)
      sh = s
    }
    const s = sh
    s.refs++
    let held = true
    return {
      fetch: s,
      release: () => {
        if (!held) return
        held = false
        // deferred so a StrictMode remount, or a download taking over from a closing preview, reuses the fetch
        setTimeout(() => {
          if (--s.refs > 0) return
          if (this.shared.get(k) === s) this.shared.delete(k)
          s.ctl.abort()
        })
      },
    }
  }

  /**
   * Object URL for a thumbnail the owner generates on demand (cached for the session). Aborting
   * `signal` (it scrolled away first) cancels the request, so the owner never makes it.
   */
  thumbURL(ownerId: string, key: string, kind: 'file' | 'dir', path?: string, signal?: AbortSignal): Promise<string | null> {
    return this.previews.url(`thumb\0${ownerId}\0${key}\0${path ?? ''}`, () =>
      this.getBlob(ownerId, { op: 'thumb', kind, key, path }, undefined, { signal }),
    )
  }

  /**
   * Object URL of an image's PREVIEW_DIM rendition. Kept in the preview cache's disk copy, so a
   * board's pictures stay sharp after a reload and while their owner is offline. Made locally
   * from any copy we hold, otherwise by the owner or a holder.
   */
  imageURL(ownerId: string, key: string, hash?: string): Promise<string | null> {
    return this.previews.url(
      `preview\0${ownerId}\0${key}`,
      async () => {
        const b = await this.getBlob(ownerId, { op: 'preview', kind: 'file', key, hash })
        return b.size > PREVIEW_BYTES ? ((await makePreview(b)) ?? b) : b
      },
      true,
    )
  }

  /**
   * Sharp rendition of an image from what this device already holds (a preview fetched before,
   * the owner's own disk, or a kept copy), never from the network: null if there's none.
   */
  async localImage(ownerId: string, key: string, hash?: string): Promise<Blob | null> {
    const cached = await this.previews.peek(`preview\0${ownerId}\0${key}`)
    if (cached) return cached
    if (ownerId !== this.self.id && !(hash && this.mirror.has(hash, this.board))) return null
    // served locally, but a relink-pending file would wait for good
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 5000)
    return this.getBlob(ownerId, { op: 'preview', kind: 'file', key, hash }, undefined, { signal: ctl.signal })
      .catch(() => null)
      .finally(() => clearTimeout(t))
  }

  /**
   * Live listing from the owner. The last listing seen is kept so the folder stays browsable
   * while the owner is offline (files then come from peers who hold copies).
   */
  async list(ownerId: string, key: string, path: string, onState?: (s: ReqState) => void): Promise<DirEntry[]> {
    const ck = `${key}/${path}`
    if (ownerId !== this.self.id && !this.p2p.reachableUsers().has(ownerId)) {
      const cached = await get<DirEntry[]>(ck, listingStore).catch(() => undefined)
      if (cached) return cached
    }
    const b = await this.getBlob(ownerId, { op: 'list', kind: 'dir', key, path }, onState)
    const entries = JSON.parse(await b.text()) as DirEntry[]
    void set(ck, entries, listingStore).catch(() => {})
    return entries
  }

  /**
   * Seekable media URL (see streamSW): each range the player asks for is its own request,
   * read from the transfer cache where it holds it, else served by the owner or any holder
   * (and cached). Ranges can't be hash-verified (only whole files can): the cache checks the
   * file once it holds all of it. The whole stream is one entry in the transfer list, active
   * while any range is in flight.
   */
  stream(ownerId: string, req: GetReq, size: number, mime: string, h: StreamHandlers = {}): Stream {
    const base = this.withHash({ ...req, op: 'file', bg: true, stream: true, sid: crypto.randomUUID() })
    const tid = `stream:${base.sid}`
    let inflight = 0
    let got = 0
    let added = false
    let stoppedBy = ''
    const track = (d: number) => {
      inflight += d
      if (!added) {
        added = true
        const peerName = ownerId === this.self.id ? 'this device' : (h.peerName ?? 'a peer')
        this.transfers.add({ id: tid, dir: 'down', name: h.name ?? 'stream', size, done: 0, state: 'active', peerName, startedAt: Date.now(), cancel: () => st.close() })
      } else if (!stoppedBy) this.transfers.patch(tid, { state: inflight ? 'active' : 'done' })
    }
    const st = openStream(size, mime, (from, to, sink) => {
      let open = true
      const finish = () => open && ((open = false), track(-1))
      track(1)
      const r = this.pull(
        ownerId,
        { ...base, from, to },
        {
          onState: (s) => {
            h.onState?.(s)
            if (s !== 'active' && !stoppedBy) this.transfers.patch(tid, { state: s })
          },
          onData: (_off, b) => sink.data(b),
        },
        (n) => {
          got += n
          this.transfers.patch(tid, { done: Math.min(size, got) })
        },
      )
      r.done.then(
        () => sink.end(),
        (e: Error) => {
          if (e instanceof CanceledBy) {
            stoppedBy = e.message
            this.transfers.patch(tid, { state: 'canceled', error: e.message })
          }
          if (e.message !== 'canceled') h.onError?.(e.message)
          sink.error(e.message)
        },
      ).finally(finish)
      return () => {
        r.cancel()
        finish()
      }
    })
    return st
  }

  /** Whole-file object URL for in-app preview (images, PDFs, media, text). */
  async previewURL(ownerId: string, req: GetReq): Promise<string> {
    return URL.createObjectURL(await this.getBlob(ownerId, { ...req, op: 'file' }))
  }

  /**
   * Streams a file from its owner (or any peer holding a copy) straight to disk. With the File
   * System Access API (Chromium) chunks are written as they arrive, so size is bounded by disk,
   * not RAM, and the saved file is kept as a copy this browser serves to others.
   * Elsewhere (Firefox) chunks accumulate in a Blob, which browsers spill to disk.
   * Resumes automatically, from another holder if needed, when the source drops.
   */
  async download(a: DownloadArgs): Promise<void> {
    // a preview of this file is already fetching it: wait for those bytes instead of asking again
    const lease = this.shared.has(fileKey(a.ownerId, a.req)) ? this.acquire(a.ownerId, a.req) : null
    let writable: any = null
    let handle: any = null
    if (canSavePicker()) {
      try {
        // must be the first await so the click's user activation is still valid
        handle = await (window as any).showSaveFilePicker({ suggestedName: a.name })
        writable = await handle.createWritable()
      } catch (e) {
        if ((e as Error).name === 'AbortError') return lease?.release()
        writable = null
      }
    }
    const req = this.withHash({ ...a.req, op: 'file' })
    const id = `down:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`
    const isMine = a.ownerId === this.self.id
    const hash = req.hash
    if (hash) this.transfers.remove(`resume:${hash}`)
    if (lease) return this.downloadShared(a, lease, id, isMine, writable, handle)
    const want = (p: Parameters<PartialCache['setWant']>[3]) => hash && this.partial.setWant(hash, { name: a.name, size: a.size, mime: '' }, this.board, p)
    // remembered, so a reload or close leaves it in Transfers to resume
    if (this.cacheable(a.ownerId, req)) void want({ want: 'download', src: { ownerId: a.ownerId, ownerName: a.ownerName, req: a.req } })
    let mime = ''
    let h: ReqHandle | null = null
    this.transfers.add({
      id, dir: 'down', name: a.name, size: a.size, done: 0, state: 'connecting',
      peerName: isMine ? 'this device' : a.ownerName, startedAt: Date.now(), cancel: () => h?.cancel(),
    })

    /** One pass over the file; `raw` skips the transfer cache (the retry after a bad pieced-together copy). */
    const once = async (raw: boolean): Promise<{ hash?: string; blob?: Blob }> => {
      const cached = !raw && this.cacheable(a.ownerId, req)
      const hasher = new Hasher()
      let acc: Blob | null = null
      let parts: BlobPart[] = []
      let pending = 0
      const handlers: Handlers = {
        onState: (s) => this.transfers.patch(id, { state: s }),
        onMeta: (m) => {
          mime = m.mime
          this.transfers.patch(id, { size: m.size })
        },
        onData: async (off, bytes) => {
          await hasher.update(bytes)
          if (writable) await writable.write({ type: 'write', position: off, data: bytes })
          else if (!cached) {
            parts.push(bytes as BlobPart)
            pending += bytes.length
            if (pending > CONSOLIDATE_AT) {
              acc = new Blob(acc ? [acc, ...parts] : parts)
              parts = []
              pending = 0
            }
          }
          this.transfers.patch(id, { done: off + bytes.length })
        },
      }
      h = cached ? this.pull(a.ownerId, req, handlers) : this.p2p.request(a.ownerId, req, handlers)
      try {
        await h.done
        // verify before closing so a bad copy never replaces the target file
        const got = await this.verify(req, hasher)
        let blob: Blob | undefined
        if (!writable) {
          blob = cached ? ((await this.partial.blob(hash!)) ?? undefined) : new Blob(acc ? [acc, ...parts] : parts, { type: mime })
          if (!blob) throw new Error('missing pieces')
        }
        if (cached) await this.partial.verified(hash!)
        return { hash: got, blob }
      } catch (e) {
        if (!cached || !BAD_COPY.test((e as Error).message)) throw e
        await this.partial.drop(hash!)
        return once(true)
      }
    }

    try {
      const { hash: got, blob } = await once(false)
      const info = { name: a.name, mime, board: this.board, alias: req.alias }
      if (writable) {
        await writable.close()
        if (got && !isMine) await this.mirror.put(got, info, { handle, file: await handle.getFile() }).catch(() => {})
        // saved to disk, and served from there: the pieces aren't needed
        if (got && this.mirror.entry(got)?.kind === 'handle') await this.partial.drop(got)
      } else {
        saveBlob(blob!, a.name)
        if (got && !isMine) await this.mirror.put(got, info, { blob: blob! })
      }
      if (this.partial.entry(hash ?? '')?.want) await want({})
      this.transfers.patch(id, { state: 'done' })
    } catch (e) {
      if (writable) await writable.abort?.().catch(() => {})
      const msg = (e as Error).message
      if (e instanceof CanceledBy && hash) {
        // the bytes so far stay cached: Resume carries on from them
        await want({ want: 'download', src: { ownerId: a.ownerId, ownerName: a.ownerName, req: a.req }, canceledBy: e.who })
        this.offerResume(hash, id, msg)
      } else {
        if (this.partial.entry(hash ?? '')?.want) await want({})
        this.transfers.patch(id, msg === 'canceled' ? { state: 'canceled' } : { state: 'error', error: msg })
      }
    }
  }

  /** Saves a file whose bytes an open preview is fetching (or has fetched) anyway. */
  private async downloadShared(a: DownloadArgs, lease: Lease, id: string, isMine: boolean, writable: any, handle: any) {
    const f = lease.fetch
    let cancel!: () => void
    const canceled = new Promise<never>((_, reject) => (cancel = () => reject(new Error('canceled'))))
    const watch = () => this.transfers.patch(id, { done: f.done, state: f.state })
    this.transfers.add({
      id, dir: 'down', name: a.name, size: a.size, done: f.done, state: f.state,
      peerName: isMine ? 'this device' : a.ownerName, startedAt: Date.now(), cancel,
    })
    f.watchers.add(watch)
    try {
      const { blob, hash } = await Promise.race([f.result, canceled])
      const info = { name: a.name, mime: blob.type, board: this.board, alias: a.req.alias }
      if (writable) {
        await writable.write(blob)
        await writable.close()
        if (hash && !isMine) await this.mirror.put(hash, info, { handle, file: await handle.getFile() }).catch(() => {})
      } else {
        saveBlob(blob, a.name)
        if (hash && !isMine) await this.mirror.put(hash, info, { blob })
      }
      this.transfers.patch(id, { state: 'done', done: blob.size })
    } catch (e) {
      if (writable) await writable.abort?.().catch(() => {})
      const msg = (e as Error).message
      this.transfers.patch(id, msg === 'canceled' ? { state: 'canceled' } : { state: 'error', error: msg })
    } finally {
      f.watchers.delete(watch)
      lease.release()
    }
  }
}
