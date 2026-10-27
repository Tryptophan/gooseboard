import { createStore, del, entries, get, set } from 'idb-keyval'
import { SMALL_FILE } from '../config'

/**
 * Copies of other people's files that THIS browser holds and can serve, keyed by content hash.
 * - 'blob': small files (<= SMALL_FILE) cached in IndexedDB; survive reloads everywhere.
 * - 'handle': a large download saved via the File System Access API (Chromium); served from
 *   that file on disk while read permission holds and it hasn't changed since saving.
 * - 'mem': a large download on browsers without save handles (Firefox); this session only.
 * Each entry records which boards reference it, so a board's load can GC what it dropped.
 */
export interface MirrorEntry {
  hash: string
  name: string
  mime: string
  size: number
  kind: 'blob' | 'handle' | 'mem'
  boards: string[]
  /** folder-file aliases (`folderAlias`) this content was fetched as */
  aliases: string[]
  at: number
  handle?: any
  /** lastModified of the saved file, to detect edits on disk */
  mtime?: number
}

export interface MirrorInfo {
  name: string
  mime: string
  board: string
  alias?: string
}

/** Identifies one version of a file inside a disk folder (owner key + path + size + mtime). */
export const folderAlias = (key: string, path: string, size: number, mtime: number) => `${key}/${path}@${size}:${mtime}`

const metaStore = createStore('gooseboard-mirror', 'meta')
const blobStore = createStore('gooseboard-mirror-blobs', 'blobs')

type Listener = () => void

export class Mirror {
  private map = new Map<string, MirrorEntry>()
  private mem = new Map<string, Blob>()
  private version = 0
  private listeners = new Set<Listener>()
  private persistAsked = false
  readonly ready: Promise<void>

  constructor() {
    this.ready = entries<string, MirrorEntry>(metaStore)
      .then((list) => list.forEach(([k, e]) => this.map.set(k, e)))
      .catch(() => {})
      .then(() => this.bump())
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getVersion = () => this.version
  private bump() {
    this.version++
    this.listeners.forEach((l) => l())
  }

  has(hash: string, board?: string) {
    const e = this.map.get(hash)
    return !!e && (!board || e.boards.includes(board))
  }

  /** What to advertise to peers on `board`. */
  heldFor(board: string): { hashes: string[]; aliases: Record<string, string> } {
    const hashes: string[] = []
    const aliases: Record<string, string> = {}
    for (const e of this.map.values()) {
      if (!e.boards.includes(board)) continue
      hashes.push(e.hash)
      e.aliases.forEach((a) => (aliases[a] = e.hash))
    }
    return { hashes, aliases }
  }

  aliasHash(alias: string): string | undefined {
    for (const e of this.map.values()) if (e.aliases.includes(alias)) return e.hash
    return undefined
  }

  entry(hash: string) {
    return this.map.get(hash)
  }

  /** The bytes, or null if gone/stale/unpermitted (stale entries are dropped). */
  async get(hash: string, board?: string): Promise<Blob | null> {
    const e = this.map.get(hash)
    if (!e || (board && !e.boards.includes(board))) return null
    try {
      if (e.kind === 'mem') return this.mem.get(hash) ?? null
      if (e.kind === 'blob') {
        const b = await get<Blob>(hash, blobStore)
        if (b && b.size === e.size) return b
      } else {
        if ((await e.handle?.queryPermission?.({ mode: 'read' })) !== 'granted') return null
        const f: File = await e.handle.getFile()
        if (f.size === e.size && f.lastModified === e.mtime) return f
      }
    } catch {
      /* fall through: treat as gone */
    }
    await this.remove(hash)
    return null
  }

  async put(hash: string, info: MirrorInfo, src: { blob: Blob } | { handle: any; file: File }) {
    const prev = this.map.get(hash)
    const kind: MirrorEntry['kind'] = 'handle' in src ? 'handle' : prev?.kind === 'blob' || src.blob.size <= SMALL_FILE ? 'blob' : 'mem'
    const e: MirrorEntry = {
      hash, name: info.name, mime: info.mime, kind, at: Date.now(),
      size: 'handle' in src ? src.file.size : src.blob.size,
      boards: union(prev?.boards, info.board),
      aliases: union(prev?.aliases, info.alias),
      handle: 'handle' in src ? src.handle : undefined,
      mtime: 'handle' in src ? src.file.lastModified : undefined,
    }
    // never downgrade a persisted copy to a session-only one
    if (prev && prev.kind !== 'mem' && kind === 'mem') return this.adopt(hash, info.board, info.alias)
    this.map.set(hash, e)
    if (kind === 'mem') this.mem.set(hash, (src as { blob: Blob }).blob)
    else {
      this.askPersist()
      if (kind === 'blob') await set(hash, (src as { blob: Blob }).blob, blobStore).catch(() => {})
      await set(hash, e, metaStore).catch(() => {})
    }
    this.bump()
  }

  /** Records that `board` (and optionally a folder alias) refers to content we already hold. */
  async adopt(hash: string, board: string, alias?: string) {
    const e = this.map.get(hash)
    if (!e || (e.boards.includes(board) && (!alias || e.aliases.includes(alias)))) return
    e.boards = union(e.boards, board)
    e.aliases = union(e.aliases, alias)
    if (e.kind !== 'mem') await set(hash, e, metaStore).catch(() => {})
    this.bump()
  }

  /**
   * Called once a board has loaded from disk (so its undo history is gone): unlinks the board
   * from entries it no longer references and deletes entries no board references.
   */
  async gc(board: string, keep: (e: MirrorEntry) => boolean) {
    await this.ready
    for (const e of [...this.map.values()]) {
      if (!e.boards.includes(board) || keep(e)) continue
      e.boards = e.boards.filter((b) => b !== board)
      if (e.boards.length) {
        if (e.kind !== 'mem') await set(e.hash, e, metaStore).catch(() => {})
      } else await this.remove(e.hash, false)
    }
    this.bump()
  }

  private async remove(hash: string, notify = true) {
    const e = this.map.get(hash)
    this.map.delete(hash)
    this.mem.delete(hash)
    if (e?.kind !== 'mem') {
      await del(hash, metaStore).catch(() => {})
      await del(hash, blobStore).catch(() => {})
    }
    if (notify) this.bump()
  }

  private askPersist() {
    if (this.persistAsked) return
    this.persistAsked = true
    void navigator.storage?.persist?.().catch(() => {})
  }
}

const union = (list: string[] | undefined, v: string | undefined) => (v && !list?.includes(v) ? [...(list ?? []), v] : [...(list ?? [])])
