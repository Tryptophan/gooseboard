import { createStore, get, set } from 'idb-keyval'
import { SMALL_FILE } from '../config'
import { canSavePicker } from '../lib/files'
import { Hasher } from '../lib/hash'
import type { Profile } from '../lib/storage'
import type { Mirror } from './mirror'
import type { GetReq, P2P, ReqState } from './p2p'
import type { DirEntry } from './sources'
import type { TransferStore } from './transfers'

const CONSOLIDATE_AT = 64 * 1024 * 1024
const listingStore = createStore('gooseboard-listings', 'listings')

export interface DownloadArgs {
  ownerId: string
  ownerName: string
  req: GetReq
  name: string
  size: number
}

export interface BlobOpts {
  onProgress?(done: number): void
  signal?: AbortSignal
}

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
    // anything small we fetched (incl. folder files someone opened) becomes servable by us
    if (hash && blob.size <= SMALL_FILE) await this.mirror.put(hash, { name, mime, board: this.board, alias: req.alias }, { blob })
    return blob
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
    let writable: any = null
    let handle: any = null
    if (canSavePicker()) {
      try {
        // must be the first await so the click's user activation is still valid
        handle = await (window as any).showSaveFilePicker({ suggestedName: a.name })
        writable = await handle.createWritable()
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        writable = null
      }
    }
    const req = this.withHash({ ...a.req, op: 'file' })
    const id = `down:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`
    const isMine = a.ownerId === this.self.id
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
}
