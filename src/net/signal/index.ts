import { NOSTR_RELAYS, TORRENT_TRACKERS } from '../../config'
import { COARSE } from '../../lib/touch'
import { NativeWebSocket, type Endpoint, type Sink, type Transport } from './core'
import { dropAll } from './glare'
import { NostrSignal } from './nostr'
import { TrackerSignal } from './torrent'

/**
 * Serverless signaling for y-webrtc. Its signaling protocol is plain topic pub/sub
 * (subscribe / publish / ping), so instead of a dedicated server we carry it over public
 * infrastructure that already relays between browsers: Nostr relays (ephemeral events) and
 * WebTorrent trackers (the opaque "offer" payload). y-webrtc opens `new WebSocket(url)`
 * through lib0; for our `p2p-signal://` URLs we hand it an in-page socket bound to one of
 * these transports. y-webrtc encrypts every signaling message with the room password (the
 * board id), so relays only ever see ciphertext under a hashed topic.
 */

const SCHEME = 'p2p-signal://'

const listeners = new Set<() => void>()
const statusChanged = () => {
  listeners.forEach((l) => l())
  reannounceSoon()
}

/**
 * y-webrtc announces a room only when its socket opens, which is as soon as the first relay of a
 * transport connects. If that one announce is lost (relay not up yet, rate-limited, peer not yet
 * subscribed there), the two sides never meet. So replay the open whenever a relay or tracker
 * comes up and every 30 s: y-webrtc re-subscribes and re-announces, and peers it is already
 * connected to ignore the repeat.
 */
const REANNOUNCE_MS = 30_000
const sockets = new Set<SignalSocket>()
let reannounceTimer: ReturnType<typeof setTimeout> | null = null
function reannounceSoon() {
  reannounceTimer ??= setTimeout(() => {
    reannounceTimer = null
    sockets.forEach((s) => s.reannounce())
  }, 1000)
}

const cache = new Map<string, Transport>()
const makers: Record<string, () => Transport> = {
  nostr: () => new NostrSignal(NOSTR_RELAYS, statusChanged),
  torrent: () => new TrackerSignal(TORRENT_TRACKERS, statusChanged),
}
function transport(kind: string): Transport | undefined {
  if (!makers[kind]) return undefined
  let t = cache.get(kind)
  if (!t) {
    t = makers[kind]()
    cache.set(kind, t)
  }
  return t
}

/** The URLs to hand y-webrtc as `signaling`. */
export const SIGNAL_URLS = Object.keys(makers).map((k) => SCHEME + k)

/** Stands in for the WebSocket lib0 would open to a y-webrtc signaling server. */
class SignalSocket implements Sink {
  readyState = 0
  binaryType = 'blob'
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null

  constructor(private t: Transport) {
    // attach once lib0 has assigned its handlers
    queueMicrotask(() => this.readyState === 0 && t.attach(this))
    sockets.add(this)
  }

  /** lib0's onopen emits 'connect', on which y-webrtc subscribes and announces every room */
  reannounce() {
    if (this.readyState === 1 && this.t.up) this.onopen?.({})
  }

  open() {
    if (this.readyState !== 0) return
    this.readyState = 1
    this.onopen?.({})
  }

  message(m: unknown) {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(m) })
  }

  send(raw: string) {
    const m = JSON.parse(raw)
    if (m.type === 'ping') queueMicrotask(() => this.message({ type: 'pong' }))
    else if (m.type === 'subscribe') m.topics?.forEach((t: string) => this.t.subscribe(t))
    else if (m.type === 'unsubscribe') m.topics?.forEach((t: string) => this.t.unsubscribe(t))
    else if (m.type === 'publish') this.t.publish(m.topic, m.data)
  }

  /** lib0 reconnects (with a fresh socket) after this fires */
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    sockets.delete(this)
    this.t.detach(this)
    this.onclose?.({})
  }
}

/**
 * Mobile browsers suspend a backgrounded page: relay sockets and peer connections die, but often
 * still look open when the page returns, and a relay that failed meanwhile may sit in a minute of
 * backoff. So after a long enough absence, rebuild everything at once. Phones and tablets only: a
 * desktop tab keeps its connections in the background, and tearing them down there would cost a
 * needless blip every time someone switches tabs.
 */
const RESUME_AFTER_MS = 10_000
function watchResume() {
  if (!matchMedia(COARSE).matches) return
  let hiddenAt = document.hidden ? Date.now() : 0
  const back = () => {
    if (document.hidden || !hiddenAt) return
    const away = Date.now() - hiddenAt
    hiddenAt = 0
    if (away < RESUME_AFTER_MS) return
    dropAll()
    cache.forEach((t) => t.resume())
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt ||= Date.now()
    else back()
  })
}

let installed = false
/** Routes `p2p-signal://` sockets to our transports; every other WebSocket is untouched. */
export function installSignaling() {
  if (installed) return
  installed = true
  watchResume()
  setInterval(() => sockets.forEach((s) => s.reannounce()), REANNOUNCE_MS)
  const Patched = function (url: string | URL, protocols?: string | string[]) {
    const u = String(url)
    const t = u.startsWith(SCHEME) ? transport(u.slice(SCHEME.length)) : undefined
    return t ? new SignalSocket(t) : new NativeWebSocket(url, protocols)
  } as unknown as typeof WebSocket
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: NativeWebSocket.prototype })
  globalThis.WebSocket = Patched
}

/** Relays/trackers and whether each is connected, for the connection popover. */
export function signalStatus(): { kind: string; endpoints: Endpoint[] }[] {
  return Object.keys(makers).map((kind) => ({ kind, endpoints: cache.get(kind)?.endpoints() ?? [] }))
}

export function onSignalStatus(l: () => void) {
  listeners.add(l)
  return () => void listeners.delete(l)
}
