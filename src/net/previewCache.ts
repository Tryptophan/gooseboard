import { clear, createStore, entries, get, set } from 'idb-keyval'

interface Entry {
  blob: Blob
}

const store = createStore('gooseboard-pictures', 'pictures')

// the previous previews database, which this replaces
try {
  indexedDB.deleteDatabase('gooseboard-previews')
} catch {
  /* no IndexedDB: nothing to clean up */
}

/** How many previews are kept on disk, and their size. */
export async function previewStats(): Promise<{ count: number; bytes: number }> {
  const all = await entries<string, Entry>(store).catch(() => [] as [string, Entry][])
  return { count: all.length, bytes: all.reduce((n, [, e]) => n + e.blob.size, 0) }
}

export const clearPreviews = () => clear(store).catch(() => {})

/**
 * Pictures of other people's files shown on the board, as object URLs: the previews and thumbnails
 * they serve us. (The thumbCache is the reverse, thumbnails of our own files that we serve.)
 * Entries marked `persist` are also kept in IndexedDB, so they survive a reload and an
 * offline owner. That copy has no size limit; only clearing it from Settings removes entries.
 */
export class PreviewCache {
  private urls = new Map<string, Promise<string | null>>()

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
      if (hit) return URL.createObjectURL(hit.blob)
    }
    const blob = await make()
    if (persist) void set(id, { blob }, store).catch(() => {})
    return URL.createObjectURL(blob)
  }
}
