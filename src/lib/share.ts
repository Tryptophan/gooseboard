/**
 * What another app shared into the installed app. The service worker parks it in a cache
 * (public/stream-sw.js), the #/share page picks a board, and the board places it on arrival.
 */
export interface Shared {
  title: string
  text: string
  url: string
  files: File[]
}

const CACHE = 'gooseboard-share'
const at = (name: string) => new URL(`${import.meta.env.BASE_URL}__share/${name}`, location.origin).href

export async function readShare(): Promise<Shared | null> {
  if (typeof caches === 'undefined') return null
  try {
    const c = await caches.open(CACHE)
    const meta = await c.match(at('meta'))
    if (!meta) return null
    const m = (await meta.json()) as Omit<Shared, 'files'> & { files: { name: string; type: string; lastModified: number }[] }
    const files: File[] = []
    for (const [i, f] of m.files.entries()) {
      const r = await c.match(at(String(i)))
      if (r) files.push(new File([await r.blob()], f.name, { type: f.type, lastModified: f.lastModified }))
    }
    return { title: m.title, text: m.text, url: m.url, files }
  } catch {
    return null
  }
}

export const clearShare = () => (typeof caches === 'undefined' ? Promise.resolve(false) : caches.delete(CACHE))

let pending: { board: string; shared: Shared } | null = null

/** Hands what was shared to `board`, which takes it once it has loaded. */
export function sendShare(board: string, shared: Shared) {
  pending = { board, shared }
}

export function takeShare(board: string): Shared | null {
  if (pending?.board !== board) return null
  const { shared } = pending
  pending = null
  return shared
}
