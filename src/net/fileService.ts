import { createStore, get, set } from 'idb-keyval'
import { SMALL_FILE } from '../config'
import { canSavePicker } from '../lib/files'
import { Hasher } from '../lib/hash'
import type { Profile } from '../lib/storage'
import type { Mirror } from './mirror'
import type { GetReq, P2P, ReqState } from './p2p'
import type { DirEntry } from './sources'
import { openStream, type Stream } from './streamSW'
import { makePreview } from './thumbs'
import type { TransferStore } from './transfers'

const CONSOLIDATE_AT = 64 * 1024 * 1024
const listingStore = createStore('gooseboard-listings', 'listings')
const previewStore = createStore('gooseboard-previews', 'previews')
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
  private thumbs = new Map<string, Promise<string | null>>()
  private previews = new Map<string, Promise<string | null>>()
  private shared = new Map<string, Shared>()

  constructor(
    private p2p: P2P,
    private self: Profile,
    private transfers: TransferStore,
    private mirror: Mirror,
    private board: string,
  ) {}

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

  private async fetch(ownerId: string, req: GetReq, onState?: (s: ReqState) => void, o: BlobOpts = {}): Promise<Fetched> {
    req = this.withHash(req)
    const parts: BlobPart[] = []
    let mime = ''
    let name = ''
    const hasher = req.op === 'file' ? new Hasher() : null
    const h = this.p2p.request(ownerId, req, {
      onMeta: (m) => {
        mime = m.mime
        name = m.name
      },
      onData: async (_o, b) => {
        parts.push(b as BlobPart)
        await hasher?.update(b)
        o.onProgress?.(hasher?.size ?? 0)
      },
      onState,
    })
    o.signal?.addEventListener('abort', () => h.cancel())
    await h.done
    const blob = new Blob(parts, { type: mime })
    const hash = await this.verify(req, hasher)
    // anything small we fetched (incl. folder files someone opened), or synced on purpose, becomes servable by us
    if (hash && (blob.size <= SMALL_FILE || o.keep)) await this.mirror.put(hash, { name, mime, board: this.board, alias: req.alias }, { blob }, { persist: o.keep })
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

  /** Object URL for a thumbnail the owner generates on demand (cached for the session). */
  thumbURL(ownerId: string, key: string, kind: 'file' | 'dir', path?: string): Promise<string | null> {
    const ck = `${ownerId}\0${key}\0${path ?? ''}`
    let p = this.thumbs.get(ck)
    if (!p) {
      p = this.getBlob(ownerId, { op: 'thumb', kind, key, path })
        .then((b) => URL.createObjectURL(b))
        .catch(() => null)
      this.thumbs.set(ck, p)
      // don't cache failures forever: owner may be offline now and online later
      p.then((u) => !u && this.thumbs.delete(ck))
    }
    return p
  }

  /**
   * Object URL of an image's PREVIEW_DIM rendition. Kept in IndexedDB, so a board's pictures
   * stay sharp after a reload and while their owner is offline. Made locally from any copy we
   * hold, otherwise by the owner or a holder.
   */
  imageURL(ownerId: string, key: string, hash?: string): Promise<string | null> {
    const ck = `${ownerId}\0${key}`
    let p = this.previews.get(ck)
    if (!p) {
      p = (async () => {
        let b = await get<Blob>(ck, previewStore).catch(() => undefined)
        if (!b) {
          b = await this.getBlob(ownerId, { op: 'preview', kind: 'file', key, hash })
          if (b.size > PREVIEW_BYTES) b = (await makePreview(b)) ?? b
          void set(ck, b, previewStore).catch(() => {})
        }
        return URL.createObjectURL(b)
      })().catch(() => null)
      this.previews.set(ck, p)
      // try again later: the owner may come online
      p.then((u) => !u && this.previews.delete(ck))
    }
    return p
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
   * served by the owner or any holder. Ranges can't be hash-verified (only whole files can),
   * so they aren't mirrored. The whole stream is one entry in the transfer list, active while
   * any range is in flight.
   */
  stream(ownerId: string, req: GetReq, size: number, mime: string, h: StreamHandlers = {}): Stream {
    const base = this.withHash({ ...req, op: 'file', bg: true, stream: true })
    const tid = `stream:${crypto.randomUUID()}`
    let inflight = 0
    let got = 0
    let added = false
    const track = (d: number) => {
      inflight += d
      if (!added) {
        added = true
        const peerName = ownerId === this.self.id ? 'this device' : (h.peerName ?? 'a peer')
        this.transfers.add({ id: tid, dir: 'down', name: h.name ?? 'stream', size, done: 0, state: 'active', peerName, startedAt: Date.now(), cancel: () => st.close() })
      } else this.transfers.patch(tid, { state: inflight ? 'active' : 'done' })
    }
    const st = openStream(size, mime, (from, to, sink) => {
      let full = false
      let open = true
      const finish = () => open && ((open = false), track(-1))
      track(1)
      const r = this.p2p.request(ownerId, { ...base, from, to }, {
        onState: (s) => {
          h.onState?.(s)
          if (s !== 'active') this.transfers.patch(tid, { state: s })
        },
        onData: (off, b) => {
          if (full) return
          got += b.length
          this.transfers.patch(tid, { done: Math.min(size, got) })
          // peers on an older build ignore `to` and send the rest of the file: clip and stop them
          sink.data(off + b.length > to ? b.subarray(0, to - off) : b)
          if (off + b.length < to) return
          full = true
          sink.end()
          r.cancel()
        },
      })
      r.done.then(
        () => !full && sink.end(),
        (e: Error) => {
          if (full) return
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
    if (lease) return this.downloadShared(a, lease, id, isMine, writable, handle)
    const hasher = new Hasher()
    let mime = ''
    let acc: Blob | null = null
    let parts: BlobPart[] = []
    let pending = 0

    const h = this.p2p.request(a.ownerId, req, {
      onState: (s) => this.transfers.patch(id, { state: s }),
      onMeta: (m) => {
        mime = m.mime
        this.transfers.patch(id, { size: m.size })
      },
      onData: async (off, bytes) => {
        await hasher.update(bytes)
        if (writable) await writable.write({ type: 'write', position: off, data: bytes })
        else {
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
    })
    this.transfers.add({
      id, dir: 'down', name: a.name, size: a.size, done: 0, state: 'connecting',
      peerName: isMine ? 'this device' : a.ownerName, startedAt: Date.now(), cancel: () => h.cancel(),
    })
    try {
      await h.done
      // verify before closing so a bad copy never replaces the target file
      const hash = await this.verify(req, hasher)
      const info = { name: a.name, mime, board: this.board, alias: req.alias }
      if (writable) {
        await writable.close()
        if (hash && !isMine) await this.mirror.put(hash, info, { handle, file: await handle.getFile() }).catch(() => {})
      } else {
        const blob = new Blob(acc ? [acc, ...parts] : parts, { type: mime })
        saveBlob(blob, a.name)
        if (hash && !isMine) await this.mirror.put(hash, info, { blob })
      }
      this.transfers.patch(id, { state: 'done' })
    } catch (e) {
      if (writable) await writable.abort?.().catch(() => {})
      const msg = (e as Error).message
      this.transfers.patch(id, msg === 'canceled' ? { state: 'canceled' } : { state: 'error', error: msg })
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
