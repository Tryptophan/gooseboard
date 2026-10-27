/**
 * Streams peer-to-peer media into <video>/<audio>. The page registers a stream (see
 * src/net/streamSW.ts) and points the element at <scope>__stream/<id>?size=&mime=; the browser
 * then asks for byte ranges as it plays and seeks, and each range is fetched from a peer by
 * the page that registered the stream. Every other request passes straight through: nothing
 * is cached here.
 */
const PREFIX = new URL('__stream/', self.registration.scope).pathname
/** longest range answered at once: the player asks again for the rest, which bounds buffering */
const CHUNK = 4 * 1024 * 1024
const MEDIA = /^(video|audio)\/[\w.+-]+$/
const NOT_MEDIA = ['document', 'iframe', 'frame', 'embed', 'object', 'script', 'style', 'worker', 'sharedworker']

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin === location.origin && url.pathname.startsWith(PREFIX)) e.respondWith(serve(e.request, url))
})

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
