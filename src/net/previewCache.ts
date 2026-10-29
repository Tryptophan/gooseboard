import { clear, createStore, del, entries, get, set } from 'idb-keyval'

/** Most the cache keeps on disk; the least recently used previews go first. */
export const PREVIEW_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024

interface Entry {
  blob: Blob
  used: number
  /** content hash the preview was made from, so a replaced file gets a new one */
  hash?: string
}

const DB = 'gooseboard-preview-cache'
const store = createStore(DB, 'previews')
/** preview id -> the boards that show it, so a board's load or removal can drop what no board needs */
const boards = createStore('gooseboard-preview-boards', 'boards')

/** The databases this one replaces: carried over once, then deleted. */
const OLD_DBS = ['gooseboard-pictures', 'gooseboard-previews']

async function migrate() {
  const have = new Set((await indexedDB.databases?.().catch(() => []))?.map((d) => d.name))
  for (const name of OLD_DBS) {
    if (!have.has(name)) continue
    const old = createStore(name, name === 'gooseboard-pictures' ? 'pictures' : 'previews')
    for (const [k, v] of await entries<string, Entry | Blob>(old).catch(() => [] as [string, Entry | Blob][])) {
      // the first version kept bare blobs under `owner\0key`
      const [id, e] = v instanceof Blob ? [`preview\0${k}`, { blob: v, used: 0 }] : [k, v]
      if ((await get(id, store).catch(() => undefined)) === undefined) await set(id, e, store).catch(() => {})
    }
    indexedDB.deleteDatabase(name)
  }
}
const migrated = migrate().catch(() => {})

/** How many previews are kept on disk, and their size. */
export async function previewStats(): Promise<{ count: number; bytes: number }> {
  const all = await entries<string, Entry>(store).catch(() => [] as [string, Entry][])
  return { count: all.length, bytes: all.reduce((n, [, e]) => n + e.blob.size, 0) }
}

export const clearPreviews = () => Promise.all([clear(store), clear(boards)]).catch(() => {})

/**
 * On board load: `used` is the preview ids `board` still shows. Previews no board shows any more
 * go, and a removed board (`used` empty) lets go of all of its.
 */
export async function gcPreviews(board: string, used: Set<string>) {
  for (const [id, bs] of await entries<string, string[]>(boards).catch(() => [] as [string, string[]][])) {
    const has = bs.includes(board)
    if (used.has(id) === has) continue
    const next = has ? bs.filter((b) => b !== board) : [...bs, board]
    if (next.length) await set(id, next, boards).catch(() => {})
    else {
      await del(id, boards).catch(() => {})
      await del(id, store).catch(() => {})
    }
  }
}

/**
 * Previews and thumbnails of other people's files shown on the board, as object URLs. (The
 * thumbCache is the reverse: thumbnails of our own files that we serve.) Entries marked `persist`
 * are also kept in IndexedDB, so they survive a reload and an offline owner, until no board shows
 * them or the disk copy passes PREVIEW_CACHE_MAX_BYTES (then least recently used go first).
 */
export class PreviewCache {
  private urls = new Map<string, Promise<string | null>>()
  private pruning: Promise<void> | null = null

  constructor(
    private board: string,
    private maxBytes = PREVIEW_CACHE_MAX_BYTES,
  ) {
    void migrated.then(() => this.prune())
  }

  /** `make` runs only when neither memory nor disk has the entry. Failures aren't cached. */
  url(id: string, make: () => Promise<Blob>, persist = false, hash?: string): Promise<string | null> {
    let p = this.urls.get(id)
    if (!p) {
      p = this.load(id, make, persist, hash).catch(() => null)
      this.urls.set(id, p)
      // don't cache failures: the owner may come online later
      p.then((u) => !u && this.urls.delete(id))
    }
    return p
  }

  /** The stored blob, if the disk copy has one. */
  async peek(id: string): Promise<Blob | undefined> {
    await migrated
    return (await get<Entry>(id, store).catch(() => undefined))?.blob
  }

  private async load(id: string, make: () => Promise<Blob>, persist: boolean, hash?: string): Promise<string> {
    if (persist) {
      await migrated
      const hit = await get<Entry>(id, store).catch(() => undefined)
      // made from another version of the file: start over
      if (hit && !(hash && hit.hash && hit.hash !== hash)) {
        void set(id, { ...hit, used: Date.now() }, store).catch(() => {})
        void this.show(id)
        return URL.createObjectURL(hit.blob)
      }
    }
    const blob = await make()
    if (persist) {
      void set(id, { blob, used: Date.now(), hash } satisfies Entry, store)
        .then(() => this.show(id))
        .then(() => this.prune())
        .catch(() => {})
    }
    return URL.createObjectURL(blob)
  }

  /** Notes that this board shows `id`. */
  private async show(id: string) {
    const bs = (await get<string[]>(id, boards).catch(() => undefined)) ?? []
    if (!bs.includes(this.board)) await set(id, [...bs, this.board], boards).catch(() => {})
  }

  /** Drops the least recently used previews until the cache fits. Runs one at a time. */
  private prune(): Promise<void> {
    this.pruning ??= (async () => {
      try {
        const all = await entries<string, Entry>(store)
        let total = all.reduce((n, [, e]) => n + e.blob.size, 0)
        if (total <= this.maxBytes) return
        all.sort((a, b) => a[1].used - b[1].used)
        for (const [k, e] of all) {
          if (total <= this.maxBytes) break
          await del(k, store)
          await del(k, boards)
          total -= e.blob.size
        }
      } catch {
        /* best effort */
      } finally {
        this.pruning = null
      }
    })()
    return this.pruning
  }
}
