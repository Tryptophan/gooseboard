import { clear, createStore, del, entries, get, set } from 'idb-keyval'

/** Most the cache keeps on disk; the least recently used entries go first. */
export const PICTURE_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024

interface Entry {
  blob: Blob
  used: number
}

const store = createStore('gooseboard-pictures', 'pictures')

// the pre-limit previews database: nothing tracked its size, so start over
try {
  indexedDB.deleteDatabase('gooseboard-previews')
} catch {
  /* no IndexedDB: nothing to clean up */
}

/** How many pictures are kept on disk, and their size. */
export async function pictureStats(): Promise<{ count: number; bytes: number }> {
  const all = await entries<string, Entry>(store).catch(() => [] as [string, Entry][])
  return { count: all.length, bytes: all.reduce((n, [, e]) => n + e.blob.size, 0) }
}

export const clearPictures = () => clear(store).catch(() => {})

/**
 * Pictures shown on the board, as object URLs. Thumbnails and previews share one cache.
 * Entries marked `persist` are also kept in IndexedDB, so they survive a reload and an
 * offline owner; that copy is capped at PICTURE_CACHE_MAX_BYTES, evicting least recently used.
 */
export class PictureCache {
  private urls = new Map<string, Promise<string | null>>()
  private pruning: Promise<void> | null = null

  constructor(private maxBytes = PICTURE_CACHE_MAX_BYTES) {
    void this.prune()
  }

  /** `make` runs only when neither memory nor disk has the entry. Failures aren't cached. */
  url(id: string, make: () => Promise<Blob>, persist = false): Promise<string | null> {
    let p = this.urls.get(id)
    if (!p) {
      p = this.load(id, make, persist).catch(() => null)
      this.urls.set(id, p)
      // don't cache failures: the owner may come online later
      p.then((u) => !u && this.urls.delete(id))
    }
    return p
  }

  /** The stored blob, if the disk copy has one. */
  async peek(id: string): Promise<Blob | undefined> {
    return (await get<Entry>(id, store).catch(() => undefined))?.blob
  }

  private async load(id: string, make: () => Promise<Blob>, persist: boolean): Promise<string> {
    if (persist) {
      const hit = await get<Entry>(id, store).catch(() => undefined)
      if (hit) {
        void set(id, { ...hit, used: Date.now() }, store).catch(() => {})
        return URL.createObjectURL(hit.blob)
      }
    }
    const blob = await make()
    if (persist) {
      void set(id, { blob, used: Date.now() } satisfies Entry, store)
        .then(() => this.prune())
        .catch(() => {})
    }
    return URL.createObjectURL(blob)
  }

  /** Drops the least recently used entries until the cache fits. Runs one at a time. */
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
