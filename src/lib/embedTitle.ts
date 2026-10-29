import * as Y from 'yjs'
import type { BoardStore } from '../model/board'
import { embedFor } from './embed'
import { normalizeUrl } from './url'

/**
 * Titles for embedded links ("Rick Astley - Never Gonna Give You Up", not "YouTube"), from the
 * providers' own oEmbed endpoints (or GitHub's API for gists), which answer browsers directly.
 * Only the person who set the link asks; the title then syncs to everyone with the item.
 */

/** providers whose oEmbed endpoint allows any page to ask (checked 2026-10-29) */
const OEMBED: Record<string, (url: string) => string> = {
  YouTube: (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}`,
  Vimeo: (u) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u)}`,
  Spotify: (u) => `https://open.spotify.com/oembed?url=${encodeURIComponent(u)}`,
  SoundCloud: (u) => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u)}`,
  Figma: (u) => `https://www.figma.com/api/oembed?url=${encodeURIComponent(u)}`,
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000) })
  return r.ok ? r.json() : null
}

/** The embed's own title, or null when the provider has none to give (or won't say). */
export async function embedTitle(url: string): Promise<string | null> {
  const e = embedFor(url)
  const n = normalizeUrl(url)
  if (!e || !n) return null
  try {
    if (OEMBED[e.provider]) {
      const t = (await getJson(OEMBED[e.provider](n)))?.title
      return typeof t === 'string' && t.trim() ? t.trim().slice(0, 200) : null
    }
    if (e.provider === 'GitHub Gist') {
      const id = new URL(n).pathname.split('/').filter(Boolean)[1]
      const g = await getJson(`https://api.github.com/gists/${id}`)
      const t = g?.description || Object.keys(g?.files ?? {})[0]
      return typeof t === 'string' && t.trim() ? t.trim().slice(0, 200) : null
    }
  } catch {
    /* offline, blocked, or slow: the card keeps the provider's name */
  }
  return null
}

/** Titles the links this browser sets (pasted, typed, dropped, or edited) once they're embeds. Returns a stop function. */
export function watchEmbedTitles(store: BoardStore): () => void {
  const asked = new Set<string>()
  const ask = (id: string) => {
    const m = store.items.get(id)
    const url = m?.get('url')
    if (m?.get('type') !== 'link' || typeof url !== 'string' || m.get('title') || asked.has(`${id} ${url}`)) return
    asked.add(`${id} ${url}`)
    void embedTitle(url).then((title) => {
      const now = store.items.get(id)
      // only if it's still that link, and nobody has named it meanwhile
      if (title && now?.get('url') === url && !now.get('title')) store.updateSilent(id, { title })
    })
  }
  const onChange = (events: Y.YEvent<any>[], tr: Y.Transaction) => {
    if (!tr.local) return
    for (const ev of events) {
      if (ev.path.length === 0) ev.changes.keys.forEach((c, id) => c.action !== 'delete' && ask(id))
      else if (ev.path.length === 1 && (ev as Y.YMapEvent<any>).keysChanged.has('url')) ask(String(ev.path[0]))
    }
  }
  store.items.observeDeep(onChange)
  return () => store.items.unobserveDeep(onChange)
}
