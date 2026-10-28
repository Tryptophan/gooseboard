/**
 * Gooseboard's service worker:
 * - Streams peer-to-peer media into <video>/<audio>. The page registers a stream (see
 *   src/net/streamSW.ts) and points the element at <scope>__stream/<id>?size=&mime=; the browser
 *   then asks for byte ranges as it plays and seeks, and each range is fetched from a peer by
 *   the page that registered the stream.
 * - Keeps the app itself offline: the build (vite.config.ts) writes its file list into BUILD,
 *   which is precached on install and served cache-first. A new version waits until the page
 *   asks it to take over (src/net/pwa.ts), so an open tab never mixes old and new code.
 * - Receives the installed app's share target: shared files and text are parked in a cache
 *   for the #/share page to place on a board.
 * Everything else passes straight through. In dev BUILD stays null and nothing is cached.
 */
const BUILD = null
const SCOPE = self.registration.scope
const PREFIX = new URL('__stream/', SCOPE).pathname
const SHARE_PATH = new URL('share-target', SCOPE).pathname
const APP = 'gooseboard-app-'
const CACHE = BUILD && APP + BUILD.version
const SHELL = new URL('index.html', SCOPE).href
const PRECACHED = new Set(BUILD ? BUILD.files.map((f) => new URL(f, SCOPE).pathname) : [])
/** longest range answered at once: the player asks again for the rest, which bounds buffering */
const CHUNK = 4 * 1024 * 1024
const MEDIA = /^(video|audio)\/[\w.+-]+$/
const NOT_MEDIA = ['document', 'iframe', 'frame', 'embed', 'object', 'script', 'style', 'worker', 'sharedworker']

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      if (BUILD) {
        const c = await caches.open(CACHE)
        // past the HTTP cache: a stale index.html would point at files this version doesn't have
        await c.addAll(BUILD.files.map((f) => new Request(new URL(f, SCOPE), { cache: 'reload' })))
      }
      // the first install takes over at once (streaming needs a controller); updates wait to be asked
      if (!self.registration.active) await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith(APP) && k !== CACHE) await caches.delete(k)
      await self.clients.claim()
    })(),
  ),
)

self.addEventListener('message', (e) => {
  if (e.data === 'gooseboard-update') self.skipWaiting()
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (url.origin !== location.origin) return
  if (url.pathname.startsWith(PREFIX)) return e.respondWith(serve(req, url))
  if (req.method === 'POST' && url.pathname === SHARE_PATH) return e.respondWith(receiveShare(req))
  if (!BUILD || req.method !== 'GET') return
  // every page is the one app shell: the router reads the hash
  if (req.mode === 'navigate' && (url.pathname === new URL(SCOPE).pathname || url.pathname === new URL(SHELL).pathname)) {
    return e.respondWith(fromCache(SHELL, req))
  }
  if (PRECACHED.has(url.pathname)) e.respondWith(fromCache(url.href, req))
})

async function fromCache(key, req) {
  const hit = await (await caches.open(CACHE)).match(key)
  return hit ?? fetch(req)
}

/** Parks what another app shared (files, title, text, url) and opens the board picker. */
async function receiveShare(req) {
  const form = await req.formData()
  const c = await caches.open('gooseboard-share')
  for (const k of await c.keys()) await c.delete(k)
  const files = form.getAll('files').filter((f) => f instanceof File)
  const str = (k) => (typeof form.get(k) === 'string' ? form.get(k) : '')
  const meta = { title: str('title'), text: str('text'), url: str('url'), files: files.map((f) => ({ name: f.name, type: f.type, lastModified: f.lastModified })) }
  await Promise.all(files.map((f, i) => c.put(new URL(`__share/${i}`, SCOPE).href, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }))))
  await c.put(new URL('__share/meta', SCOPE).href, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }))
  return Response.redirect(new URL('#/share', SCOPE).href, 303)
}

async function serve(req, url) {
  // only media elements may read these: never render peer bytes as a page in our origin
  if (req.mode === 'navigate' || NOT_MEDIA.includes(req.destination)) return new Response(null, { status: 403 })
  const id = url.pathname.slice(PREFIX.length)
  const size = Number(url.searchParams.get('size'))
  if (!id || !(size > 0)) return new Response(null, { status: 404 })
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? 'bytes=0-')
  let from = 0
  let last = size - 1
  if (m && m[1] === '' && m[2] !== '') from = Math.max(0, size - Number(m[2])) // suffix: the last N bytes
  else if (m && m[1] !== '') {
    from = Number(m[1])
    if (m[2] !== '') last = Math.min(Number(m[2]), size - 1)
  }
  if (!m || from >= size || last < from) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  last = Math.min(last, from + CHUNK - 1)

  const port = await open(id, from, last + 1)
  if (!port) return new Response(null, { status: 404 })
  const body = new ReadableStream({
    start(c) {
      port.onmessage = ({ data }) => {
        if (data.t === 'data') c.enqueue(new Uint8Array(data.b))
        else if (data.t === 'end') {
          c.close()
          port.close()
        } else if (data.t === 'err') {
          c.error(new Error(data.msg))
          port.close()
        }
      }
    },
    cancel() {
      port.postMessage({ t: 'cancel' })
      port.close()
    },
  })
  const mime = url.searchParams.get('mime') ?? ''
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': MEDIA.test(mime) ? mime : 'application/octet-stream',
      'Content-Length': String(last - from + 1),
      'Content-Range': `bytes ${from}-${last}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    },
  })
}

/** Asks every open tab for the range; the one that registered `id` answers on its port. */
async function open(id, from, to) {
  const wins = await self.clients.matchAll({ type: 'window' })
  return new Promise((resolve) => {
    let left = wins.length
    const timer = setTimeout(() => resolve(null), 5000)
    const settle = (port) => {
      clearTimeout(timer)
      resolve(port)
    }
    if (!left) return settle(null)
    for (const w of wins) {
      const ch = new MessageChannel()
      ch.port1.onmessage = ({ data }) => {
        if (data.t === 'ok') settle(ch.port1)
        else {
          ch.port1.close()
          if (--left === 0) settle(null)
        }
      }
      w.postMessage({ t: 'gooseboard-range', id, from, to }, [ch.port2])
    }
  })
}
