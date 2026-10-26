import { canSavePicker } from '../lib/files'
import type { Profile } from '../lib/storage'
import type { GetReq, P2P, ReqState } from './p2p'
import type { DirEntry } from './sources'
import type { TransferStore } from './transfers'

const CONSOLIDATE_AT = 64 * 1024 * 1024

export interface DownloadArgs {
  ownerId: string
  ownerName: string
  req: GetReq
  name: string
  size: number
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
  ) {}

  async getBlob(ownerId: string, req: GetReq, onState?: (s: ReqState) => void): Promise<Blob> {
    const parts: BlobPart[] = []
    let mime = ''
    const h = this.p2p.request(ownerId, req, {
      onMeta: (m) => (mime = m.mime),
      onData: (_o, b) => void parts.push(b as BlobPart),
      onState,
    })
    await h.done
    return new Blob(parts, { type: mime })
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

  async list(ownerId: string, key: string, path: string, onState?: (s: ReqState) => void): Promise<DirEntry[]> {
    const b = await this.getBlob(ownerId, { op: 'list', kind: 'dir', key, path }, onState)
    return JSON.parse(await b.text()) as DirEntry[]
  }

  /** Whole-file object URL for in-app preview (images, PDFs, media, text). */
  async previewURL(ownerId: string, req: GetReq): Promise<string> {
    return URL.createObjectURL(await this.getBlob(ownerId, { ...req, op: 'file' }))
  }

  /**
   * Streams a file from its owner straight to disk. With the File System Access API
   * (Chromium) chunks are written as they arrive, so size is bounded by disk, not RAM.
   * Elsewhere (Firefox) chunks accumulate in a Blob, which browsers spill to disk.
   * Resumes automatically if the owner drops and reconnects.
   */
  async download(a: DownloadArgs): Promise<void> {
    let writable: any = null
    if (canSavePicker()) {
      try {
        // must be the first await so the click's user activation is still valid
        const handle = await (window as any).showSaveFilePicker({ suggestedName: a.name })
        writable = await handle.createWritable()
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        writable = null
      }
    }
    const id = `down:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`
    const isMine = a.ownerId === this.self.id
    let mime = ''
    let acc: Blob | null = null
    let parts: BlobPart[] = []
    let pending = 0

    const h = this.p2p.request(a.ownerId, { ...a.req, op: 'file' }, {
      onState: (s) => this.transfers.patch(id, { state: s }),
      onMeta: (m) => {
        mime = m.mime
        this.transfers.patch(id, { size: m.size })
      },
      onData: async (off, bytes) => {
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
      if (writable) await writable.close()
      else saveBlob(new Blob(acc ? [acc, ...parts] : parts, { type: mime }), a.name)
      this.transfers.patch(id, { state: 'done' })
    } catch (e) {
      if (writable) await writable.abort?.().catch(() => {})
      const msg = (e as Error).message
      this.transfers.patch(id, msg === 'canceled' ? { state: 'canceled' } : { state: 'error', error: msg })
    }
  }
}
