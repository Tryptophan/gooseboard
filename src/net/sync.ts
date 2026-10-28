import { SMALL_FILE } from '../config'
import { getAutoSyncMax, subscribeAutoSync } from '../lib/autoSync'
import { hashBlob } from '../lib/hash'
import type { Profile } from '../lib/storage'
import type { BoardStore } from '../model/board'
import type { FileItem } from '../model/types'
import type { FileService } from './fileService'
import type { Mirror } from './mirror'
import type { P2P, ReqState } from './p2p'
import type { LocalSources } from './sources'
import type { TransferStore } from './transfers'

export type SyncStatus = 'synced' | 'syncing' | 'unsynced' | 'unavailable'

export interface SyncState {
  status: SyncStatus
  /** 0..1 while syncing */
  pct?: number
  /** online peers (other than me) that can serve it */
  holders: number
}

const CONCURRENCY = 2
const RETRY_MS = 15_000

interface Active {
  owner: string
  done: number
  size: number
  ctl: AbortController
}

type Listener = () => void

/**
 * Per-board background replication. Metadata (name, size, thumb) arrives with the doc first;
 * then the owner backfills each file's content hash, and every peer pulls files up to its
 * auto-sync size (lib/autoSync) into its Mirror from whoever holds them. Larger files stay
 * unsynced until someone downloads one or syncs it by hand (syncNow).
 */
export class FileSync {
  private active = new Map<string, Active>()
  private failedAt = new Map<string, number>()
  private hashing = new Set<string>()
  /** hashes synced by hand this session, whatever their size */
  private manual = new Set<string>()
  private hashQueue: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private retry: ReturnType<typeof setInterval>
  private unsubs: (() => void)[]
  private version = 0
  private listeners = new Set<Listener>()

  constructor(
    private store: BoardStore,
    private p2p: P2P,
    private mirror: Mirror,
    private sources: LocalSources,
    private files: FileService,
    private self: Profile,
    private transfers: TransferStore,
  ) {
    const s = this.schedule
    this.unsubs = [store.subscribe(s), p2p.subscribe(s), mirror.subscribe(s), sources.subscribe(s), subscribeAutoSync(s)]
    this.retry = setInterval(s, RETRY_MS)
    store.onLoaded(s)
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getVersion = () => this.version
  private emit() {
    this.version++
    this.listeners.forEach((l) => l())
  }

  stateOf(it: FileItem): SyncState {
    const holders = this.holders(it).length
    if ((it.owner === this.self.id && this.sources.isReady(it.key)) || (it.hash && this.mirror.has(it.hash))) return { status: 'synced', holders }
    const a = it.hash ? this.active.get(it.hash) : undefined
    if (a) return { status: 'syncing', pct: a.size ? a.done / a.size : 0, holders }
    return { status: holders ? 'unsynced' : 'unavailable', holders }
  }

  /** True when this file is too big to sync on its own but could be synced by hand now. */
  canSync(it: FileItem): boolean {
    if (it.owner === this.self.id || !it.hash || this.active.has(it.hash)) return false
    // a copy held only for this session (opened, not synced) can be kept too
    if (this.mirror.has(it.hash)) return this.mirror.entry(it.hash)?.kind === 'mem'
    return this.holders(it).length > 0
  }

  /** Keeps a copy of a (big) file in this browser, as if it were small enough to auto-sync. */
  syncNow(it: FileItem) {
    const hash = it.hash
    if (!hash) return
    if (this.mirror.entry(hash)?.kind === 'mem') {
      const board = this.store.id
      void this.mirror.get(hash, board).then((blob) => blob && this.mirror.put(hash, { name: it.name, mime: it.mime, board }, { blob }, { persist: true }))
      return
    }
    this.manual.add(hash)
    this.failedAt.delete(hash)
    this.schedule()
  }

  private holders(it: FileItem): string[] {
    const out = new Set(it.hash ? this.p2p.holders(it.hash) : [])
    if (it.owner !== this.self.id && this.p2p.reachableUsers().has(it.owner)) out.add(it.owner)
    return [...out]
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer)
    clearInterval(this.retry)
    this.unsubs.forEach((u) => u())
    this.active.forEach((a) => a.ctl.abort())
    this.listeners.clear()
  }

  private schedule = () => {
    if (!this.timer) this.timer = setTimeout(this.run, 200)
  }

  private run = () => {
    this.timer = null
    if (!this.store.loaded) return
    const board = this.store.id
    const files = [...this.store.getSnapshot().all.values()].filter((i): i is FileItem => i.type === 'file')
    const wanted = new Set<string>()
    for (const it of files) {
      const mine = it.owner === this.self.id
      if (mine) {
        // hash what I share (metadata went out first), and keep my small files servable after reloads
        const need = !it.hash || (it.size <= SMALL_FILE && !this.mirror.has(it.hash))
        if (need && this.sources.isReady(it.key)) this.hashOwn(it)
      }
      if (!it.hash) continue
      wanted.add(it.hash)
      if (this.mirror.has(it.hash)) {
        if (!this.mirror.has(it.hash, board)) void this.mirror.adopt(it.hash, board)
        continue
      }
      if (mine || (it.size > getAutoSyncMax() && !this.manual.has(it.hash)) || this.active.has(it.hash) || this.active.size >= CONCURRENCY) continue
      if (Date.now() - (this.failedAt.get(it.hash) ?? 0) < RETRY_MS) continue
      if (this.holders(it).length) this.fetch(it)
    }
    // stop fetches nobody can serve any more, or for files that left the board
    for (const [hash, a] of this.active) {
      const holders = this.p2p.holders(hash).length + (this.p2p.reachableUsers().has(a.owner) ? 1 : 0)
      if (!wanted.has(hash) || !holders) a.ctl.abort()
    }
    this.emit()
  }

  private hashOwn(it: FileItem) {
    const tag = `own:${it.id}`
    if (this.hashing.has(it.id) || Date.now() - (this.failedAt.get(tag) ?? 0) < RETRY_MS) return
    this.hashing.add(it.id)
    this.hashQueue = this.hashQueue.then(async () => {
      try {
        const f = await this.sources.getFile(it.key)
        if (!f) throw new Error('unlinked')
        const hash = await hashBlob(f)
        // the owner is authoritative: if the file changed on disk, the board follows it
        if (hash !== it.hash) this.store.updateSilent(it.id, { hash })
        if (f.size <= SMALL_FILE) await this.mirror.put(hash, { name: it.name, mime: it.mime, board: this.store.id }, { blob: f })
      } catch {
        this.failedAt.set(tag, Date.now())
      } finally {
        this.hashing.delete(it.id)
        this.schedule()
      }
    })
  }

  private fetch(it: FileItem) {
    const hash = it.hash!
    const a: Active = { owner: it.owner, done: 0, size: it.size, ctl: new AbortController() }
    this.active.set(hash, a)
    let last = 0
    // listed with the other transfers, so syncing is visible (and cancellable) like any download
    const tid = `sync:${this.store.id}:${hash}`
    this.transfers.add({ id: tid, dir: 'down', name: it.name, size: it.size, done: 0, state: 'connecting', peerName: it.ownerName, startedAt: Date.now(), cancel: () => a.ctl.abort() })
    this.files
      .getBlob(it.owner, { op: 'file', kind: 'file', key: it.key, hash, bg: true }, (s: ReqState) => this.transfers.patch(tid, { state: s }), {
        signal: a.ctl.signal,
        keep: true,
        onProgress: (d) => {
          a.done = d
          this.transfers.patch(tid, { done: d })
          if (Date.now() - last > 150) {
            last = Date.now()
            this.emit()
          }
        },
      })
      .then(
        () => this.transfers.patch(tid, { state: 'done', done: it.size }),
        (e: Error) => {
          this.failedAt.set(hash, Date.now())
          this.transfers.patch(tid, a.ctl.signal.aborted || e.message === 'canceled' ? { state: 'canceled' } : { state: 'error', error: e.message })
        },
      )
      .finally(() => {
        this.active.delete(hash)
        this.schedule()
      })
  }
}
