import { clear, createStore, del, entries, get, keys, set } from 'idb-keyval'

/**
 * Thumbnails this browser has made of the files it shares, kept in IndexedDB so a big folder costs
 * its decoding once, not once per visit (or per peer). Keyed by source key, path, size, and
 * modified time, so an edited file gets a new one; null records a file that has no thumbnail.
 */
const store = createStore('gooseboard-thumbs', 'thumbs')
/** source key -> the boards it's shared on, so a board's load can drop thumbnails of what it no longer shares */
const owners = createStore('gooseboard-thumb-boards', 'boards')

/** Most the thumbnails keep on disk; the least recently used go first. */
export const THUMB_CACHE_MAX_BYTES = 256 * 1024 * 1024

/** `used` is 0 for thumbnails stored before the limit existed, which are the first to go. */
interface Entry {
  blob: Blob | null
  used: number
}
const entryOf = (v: Entry | Blob | null | undefined): Entry | undefined =>
  v === undefined ? undefined : v === null || v instanceof Blob ? { blob: v, used: 0 } : v

export const thumbKey = (key: string, path: string, f: File) => `${key}\0${path}\0${f.size}:${f.lastModified}`

/** The stored thumbnail, null if the file has none, undefined if it was never made. */
export async function loadThumb(k: string): Promise<Blob | null | undefined> {
  const e = entryOf(await get<Entry | Blob | null>(k, store).catch(() => undefined))
  if (e) void set(k, { ...e, used: Date.now() } satisfies Entry, store).catch(() => {})
  return e?.blob
}
export function saveThumb(k: string, b: Blob | null, board: string) {
  void set(k, { blob: b, used: Date.now() } satisfies Entry, store)
    .then(() => pruneThumbs())
    .catch(() => {})
  const key = k.slice(0, k.indexOf('\0'))
  void get<string[]>(key, owners)
    .then((bs = []) => (bs.includes(board) ? undefined : set(key, [...bs, board], owners)))
    .catch(() => {})
}

/** On board load: `used` is the source keys `board` still shares; thumbnails no board uses any more go. */
export async function gcThumbs(board: string, used: Set<string>) {
  for (const [key, bs] of await entries<string, string[]>(owners).catch(() => [] as [string, string[]][])) {
    const has = bs.includes(board)
    if (used.has(key) === has) continue
    const next = has ? bs.filter((b) => b !== board) : [...bs, board]
    if (next.length) await set(key, next, owners).catch(() => {})
    else {
      await del(key, owners).catch(() => {})
      await dropThumbsFor(key)
    }
  }
}

/** Drops every thumbnail made from source `key` (it's no longer shared). */
export async function dropThumbsFor(key: string) {
  const all = await keys<string>(store).catch(() => [] as string[])
  await Promise.all(all.filter((k) => k.startsWith(`${key}\0`)).map((k) => del(k, store).catch(() => {})))
}

/** How many thumbnails are kept, and their size. */
export async function thumbStats(): Promise<{ count: number; bytes: number }> {
  const all = await entries<string, Entry | Blob | null>(store).catch(() => [] as [string, Entry | Blob | null][])
  return { count: all.length, bytes: all.reduce((n, [, v]) => n + (entryOf(v)?.blob?.size ?? 0), 0) }
}

let pruning: Promise<void> | null = null
/** Drops the least recently used thumbnails until the cache fits. Runs one at a time. */
function pruneThumbs(): Promise<void> {
  pruning ??= (async () => {
    try {
      const all = await entries<string, Entry | Blob | null>(store)
      let total = all.reduce((n, [, v]) => n + (entryOf(v)?.blob?.size ?? 0), 0)
      if (total <= THUMB_CACHE_MAX_BYTES) return
      all.sort((a, b) => entryOf(a[1])!.used - entryOf(b[1])!.used)
      for (const [k, v] of all) {
        if (total <= THUMB_CACHE_MAX_BYTES) break
        await del(k, store)
        total -= entryOf(v)?.blob?.size ?? 0
      }
    } catch {
      /* best effort */
    } finally {
      pruning = null
    }
  })()
  return pruning
}

export const clearThumbs = () => Promise.all([clear(store), clear(owners)]).catch(() => {})

/** Thrown by Lanes.run for a job whose asker left before its turn. */
export class Gone extends Error {
  constructor() {
    super('canceled')
  }
}

/**
 * Runs at most `n` jobs at a time, newest first: someone scrolling through a folder wants what's on
 * screen now, not what they flew past. A job whose asker has gone by its turn is skipped.
 */
export class Lanes {
  private busy = 0
  private queue: { start: () => void; gone: () => boolean; drop: () => void }[] = []

  constructor(private n: number) {}

  run<T>(job: () => Promise<T>, gone: () => boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.busy++
        job()
          .then(resolve, reject)
          .finally(() => {
            this.busy--
            this.next()
          })
      }
      this.queue.push({ start, gone, drop: () => reject(new Gone()) })
      this.next()
    })
  }

  /** Lets go of waiting jobs whose askers have gone. */
  sweep() {
    this.queue = this.queue.filter((j) => !j.gone() || (j.drop(), false))
  }

  private next() {
    while (this.busy < this.n && this.queue.length) {
      const j = this.queue.pop()!
      if (j.gone()) j.drop()
      else j.start()
    }
  }
}
