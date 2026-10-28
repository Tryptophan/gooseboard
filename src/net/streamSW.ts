/**
 * Page side of public/stream-sw.js: media elements play a virtual URL, and the service worker
 * turns the player's Range requests into messages here, answered with bytes from an opener
 * (FileService.stream fetches each range from a peer). Without a controlling service worker
 * (unsupported, private windows, hard reload) canStream() is false and callers fall back to
 * whole-file fetches.
 */
export interface RangeSink {
  data(bytes: Uint8Array): void
  end(): void
  error(msg: string): void
}

/** Starts sending bytes [from, to) to `sink`; returns a function that stops it. */
export type RangeOpener = (from: number, to: number, sink: RangeSink) => () => void

export interface Stream {
  url: string
  close(): void
}

const streams = new Map<string, { open: RangeOpener; live: Set<() => void> }>()
let ready = false

export const canStream = () => ready

/** Registers the service worker (streaming, offline, share target); resolves to its registration. */
export function initStreaming(): Promise<ServiceWorkerRegistration | undefined> {
  const sw = navigator.serviceWorker
  if (!sw) return Promise.resolve(undefined)
  const check = () => void (ready = !!sw.controller)
  sw.addEventListener('controllerchange', check)
  sw.addEventListener('message', onMessage)
  sw.startMessages()
  check()
  const base = import.meta.env.BASE_URL
  return sw.register(`${base}stream-sw.js`, { scope: base }).catch((e) => {
    console.warn('[gooseboard] streaming unavailable', e)
    return undefined
  })
}

/** A URL a media element can play and seek; bytes come from `open` as the player asks for them. */
export function openStream(size: number, mime: string, open: RangeOpener): Stream {
  const id = crypto.randomUUID()
  const s = { open, live: new Set<() => void>() }
  streams.set(id, s)
  const q = new URLSearchParams({ size: String(size), mime })
  return {
    url: `${import.meta.env.BASE_URL}__stream/${id}?${q}`,
    close: () => {
      streams.delete(id)
      s.live.forEach((stop) => stop())
    },
  }
}

function onMessage(e: MessageEvent) {
  if (e.data?.t !== 'gooseboard-range') return
  const port = e.ports[0]
  const s = streams.get(e.data.id)
  if (!port) return
  if (!s) return port.postMessage({ t: 'no' })
  port.postMessage({ t: 'ok' })
  let stop = () => {}
  const done = () => {
    s.live.delete(cancel)
    port.close()
  }
  const cancel = () => {
    stop()
    done()
  }
  s.live.add(cancel)
  port.onmessage = (m) => m.data?.t === 'cancel' && cancel()
  stop = s.open(e.data.from, e.data.to, {
    data: (bytes) => {
      // copy out of the (larger) frame buffer so only these bytes are transferred. Not slice():
      // frames off the wire are simple-peer Buffers, whose slice() is a view of the whole frame
      const b = new Uint8Array(bytes).buffer
      port.postMessage({ t: 'data', b }, [b])
    },
    end: () => {
      port.postMessage({ t: 'end' })
      done()
    },
    error: (msg) => {
      port.postMessage({ t: 'err', msg })
      done()
    },
  })
}
