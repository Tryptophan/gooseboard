import type { WebrtcProvider } from 'y-webrtc'
import { tag } from '../lib/diag'
import { FRAME_SIZE, HIGH_WATER, LOW_WATER } from '../config'
import { mimeOf } from '../lib/files'
import type { Profile } from '../lib/storage'
import type { Mirror } from './mirror'
import type { PartialCache } from './partial'
import { dropIfStuck, fixGlare } from './signal/glare'
import type { LocalSources } from './sources'
import { makePreview, makeThumb } from './thumbs'
import type { TransferStore } from './transfers'

/**
 * Side channel for file bytes, riding on the same WebRTC data channels y-webrtc already
 * opened between every pair of peers (full mesh). y-webrtc's own messages start with a
 * varuint type 0..4, so frames beginning with MAGIC are ours; we intercept them before
 * y-webrtc sees them. Bytes are read from the owner's disk on demand: never stored in the doc.
 * Peers that hold a copy (see Mirror) advertise its content hash with a `have` message, so a
 * request carrying `hash` can be served by the owner or any holder, failing over mid-stream.
 * Complete, verified entries of the transfer cache (see PartialCache) are advertised and served the same way.
 */
const MAGIC = 0x67
const K_JSON = 1
const K_DATA = 2
const DATA_HEADER = 14 // magic, kind, u32 request id, f64 offset
const PAYLOAD = FRAME_SIZE - DATA_HEADER
const BLOCK = 256 * 1024
const enc = new TextEncoder()
const dec = new TextDecoder()

/** preview: a PREVIEW_DIM rendition of an image (older peers answer with the whole file) */
export type Op = 'file' | 'thumb' | 'preview' | 'list'

export interface GetReq {
  op: Op
  /** a single shared file, or a path inside a linked directory */
  kind: 'file' | 'dir'
  key: string
  path?: string
  from?: number
  /** exclusive end of a byte range (streaming); the whole rest of the file when absent */
  to?: number
  /** content hash: lets holders other than the owner serve it, and the receiver verify it */
  hash?: string
  /** requester-side only: folder-file alias (see folderAlias) to record a fetched copy under */
  alias?: string
  /** a background fetch (syncing, streaming) rather than one the person asked for */
  bg?: boolean
  /** a range of a media stream: the server lists all of one peer's ranges of a file as one transfer */
  stream?: boolean
  /** which playback of it, so the server can cancel just that one */
  sid?: string
}

export interface Meta {
  name: string
  size: number
  mime: string
}

type Wire =
  | { t: 'hello'; user: string; name: string }
  | { t: 'get'; id: number; req: GetReq }
  | { t: 'meta'; id: number; meta: Meta }
  | { t: 'end'; id: number }
  // canceled: the sender stopped it on purpose (older receivers treat it as failed, with msg)
  | { t: 'err'; id: number; code: 'notfound' | 'failed' | 'canceled'; msg?: string }
  | { t: 'wait'; id: number; reason: 'relink' }
  | { t: 'cancel'; id: number }
  | { t: 'have'; hashes: string[]; aliases: Record<string, string> }

interface Link {
  peerId: string
  conn: any
  /** when the channel opened without a hello yet (see tick) */
  openedAt?: number
  userId?: string
  name?: string
  have?: Set<string>
  aliases?: Record<string, string>
}

interface Resolved extends Meta {
  read(a: number, b: number): Promise<ArrayBuffer>
  /** served from a mirrored copy rather than the owner's linked source */
  mirror?: boolean
}

export type ReqState = 'connecting' | 'active' | 'waiting-owner' | 'waiting-relink'

export interface Handlers {
  onMeta?(m: Meta): void
  onData?(offset: number, bytes: Uint8Array): void | Promise<void>
  onState?(s: ReqState): void
}

export interface ReqHandle {
  done: Promise<Meta | undefined>
  cancel(): void
}

interface ActiveReq {
  id: number
  ownerId: string
  req: GetReq
  h: Handlers
  received: number
  meta?: Meta
  chain: Promise<void>
  settled: boolean
  link?: Link
  /** users that answered notfound/failed: never asked again for this request */
  bad: Set<string>
  /** users that answered "wait for relink": only asked again when nobody else can serve */
  skip: Set<string>
  local: boolean
  startedAt: number
  patienceMs: number
  resolve(m: Meta | undefined): void
  reject(e: Error): void
}

/** The other side stopped this transfer on purpose: don't look for another source. */
export class CanceledBy extends Error {
  constructor(readonly who: string) {
    super(`Canceled by ${who}`)
  }
}

export interface PendingRelink {
  key: string
  kind: 'file' | 'dir'
  name: string
  askedBy: string[]
}

type Listener = () => void

export const encodeJSON = (msg: Wire): Uint8Array => {
  const body = enc.encode(JSON.stringify(msg))
  const out = new Uint8Array(body.length + 2)
  out[0] = MAGIC
  out[1] = K_JSON
  out.set(body, 2)
  return out
}

export const encodeData = (id: number, offset: number, bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(DATA_HEADER + bytes.length)
  const dv = new DataView(out.buffer)
  out[0] = MAGIC
  out[1] = K_DATA
  dv.setUint32(2, id)
  dv.setFloat64(6, offset)
  out.set(bytes, DATA_HEADER)
  return out
}

export const decodeData = (buf: Uint8Array) => {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { id: dv.getUint32(2), offset: dv.getFloat64(6), bytes: buf.subarray(DATA_HEADER) }
}

export class P2P {
  private links = new Map<string, Link>()
  private reqs = new Map<number, ActiveReq>()
  private serving = new Map<string, { cancelled: boolean; tid?: string; byMe?: boolean }>()
  private waiting: { link: Link; id: number; req: GetReq }[] = []
  private pending = new Map<string, PendingRelink>()
  private thumbCache = new Map<string, Blob | null>()
  private previewCache = new Map<string, Promise<Blob | null>>()
  /** stream transfer id -> ranges of it being served right now */
  private streamsOut = new Map<string, number>()
  /** stream transfers this person canceled: further ranges of them are refused */
  private streamsStopped = new Set<string>()
  private nextId = (Math.random() * 2 ** 30) | 0
  private timer: ReturnType<typeof setInterval>
  private version = 0
  private listeners = new Set<Listener>()
  private pendingSnap: PendingRelink[] = []

  constructor(
    private provider: WebrtcProvider,
    private self: Profile,
    readonly sources: LocalSources,
    readonly transfers: TransferStore,
    /** name/kind of an item this person shares, so relink prompts can say what is being asked for */
    private lookup: (key: string) => { name: string; kind: 'file' | 'dir' } | undefined,
    readonly mirror: Mirror,
    private board: string,
    private partial: PartialCache,
  ) {
    this.timer = setInterval(this.tick, 500)
    let held = partial.heldVersion
    const unsubPartial = partial.subscribe(() => held !== partial.heldVersion && ((held = partial.heldVersion), this.advertiseSoon()))
    const unsubMirror = mirror.subscribe(this.advertiseSoon)
    this.unsubMirror = () => (unsubMirror(), unsubPartial())
    // y-webrtc creates its room asynchronously. Hook the connection map the moment it exists so we
    // intercept our frames from a connection's very first message (a poll alone would race).
    void Promise.resolve((provider as any).key).then(() => this.hookRoom())
    this.tick()
  }

  private hooked = false
  private hookRoom() {
    const map: Map<string, any> | undefined = (this.provider as any).room?.webrtcConns
    if (!map || this.hooked) return
    this.hooked = true
    const set = map.set.bind(map)
    map.set = (peerId: string, conn: any) => {
      set(peerId, conn)
      this.linkConn(peerId, conn)
      return map
    }
    map.forEach((conn, peerId) => this.linkConn(peerId, conn))
  }

  private linkConn(peerId: string, conn: any) {
    fixGlare(conn, this.provider)
    dropIfStuck(conn)
    const cur = this.links.get(peerId)
    if (cur && cur.conn === conn) return
    const link: Link = { peerId, conn }
    this.links.set(peerId, link)
    this.attach(link)
    this.emit()
  }

  // ---- observable state ----
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getVersion = () => this.version
  private emit() {
    this.version++
    this.pendingSnap = [...this.pending.values()]
    this.listeners.forEach((l) => l())
  }
  getPending = () => this.pendingSnap

  /** Users we hold a live data channel to. */
  reachableUsers(): Set<string> {
    const s = new Set<string>()
    this.links.forEach((l) => l.userId && l.conn.connected && s.add(l.userId))
    return s
  }

  /** Each link's state, with ids tagged, for diagnostics. */
  diagInfo() {
    const links = [...this.links.values()].map((l) => {
      const pc: RTCPeerConnection | undefined = l.conn.peer?._pc
      return {
        peer: tag(l.peerId),
        user: l.userId ? tag(l.userId) : null,
        connected: !!l.conn.connected,
        hello: !!l.userId,
        connectionState: pc?.connectionState,
        iceConnectionState: pc?.iceConnectionState,
        signalingState: pc?.signalingState,
        have: l.have?.size ?? 0,
      }
    })
    return { links, requests: this.reqs.size, serving: this.serving.size, waiting: this.waiting.length, pendingRelinks: this.pending.size }
  }

  get peerCount() {
    return [...this.links.values()].filter((l) => l.conn.connected).length
  }

  /** Reachable users (other than me) advertising a copy of `hash`. */
  holders(hash: string): string[] {
    const out = new Set<string>()
    this.links.forEach((l) => l.userId && l.userId !== this.self.id && l.conn.connected && l.have?.has(hash) && out.add(l.userId))
    return [...out]
  }

  /** Content hash a reachable peer (or this browser) recorded for a folder-file alias. */
  aliasHash(alias: string): string | undefined {
    const mine = this.mirror.aliasHash(alias)
    if (mine) return mine
    for (const l of this.links.values()) if (l.conn.connected && l.aliases?.[alias]) return l.aliases[alias]
    return undefined
  }

  // ---- advertising what this browser holds ----
  private unsubMirror: () => void
  private haveTimer: ReturnType<typeof setTimeout> | null = null
  private advertiseSoon = () => {
    if (this.haveTimer) clearTimeout(this.haveTimer)
    this.haveTimer = setTimeout(() => {
      this.haveTimer = null
      this.links.forEach((l) => this.sendHave(l))
    }, 300)
  }
  private sendHave(link: Link) {
    const { hashes, aliases } = this.mirror.heldFor(this.board)
    const all = [...new Set([...hashes, ...this.partial.heldFor(this.board)])]
    void this.sendFrame(link, encodeJSON({ t: 'have', hashes: all, aliases })).catch(() => {})
  }

  destroy() {
    clearInterval(this.timer)
    if (this.haveTimer) clearTimeout(this.haveTimer)
    this.unsubMirror()
    this.reqs.forEach((ar) => this.fail(ar, new Error('closed')))
    this.listeners.clear()
  }

  // ---- link management ----
  private tick = () => {
    const room = (this.provider as any).room
    const conns: Map<string, any> | undefined = room?.webrtcConns
    let changed = false
    if (conns) {
      this.hookRoom()
      for (const [peerId, conn] of conns) {
        if (this.links.get(peerId)?.conn !== conn) {
          this.linkConn(peerId, conn)
          changed = true
        }
      }
    }
    for (const [peerId, l] of [...this.links]) {
      if (!conns?.has(peerId) || l.conn.closed) {
        this.links.delete(peerId)
        this.linkDown(l)
        changed = true
      } else if (l.conn.connected && !l.userId) {
        // Both sides dialled at once (glare): y-webrtc can end up with each side holding the
        // wrong half of two connections, "connected" but deaf. No hello means nothing arrives:
        // drop it after a jittered wait so y-webrtc re-announces and dials again.
        l.openedAt ??= Date.now() + Math.random() * 4000
        if (Date.now() - l.openedAt > 8000) l.conn.peer?.destroy()
      }
    }
    const now = Date.now()
    for (const ar of [...this.reqs.values()]) {
      if (ar.settled || ar.local) continue
      if (ar.link && (!ar.link.conn.connected || ar.link.conn.closed)) {
        ar.link = undefined
        ar.h.onState?.('waiting-owner')
      }
      if (!ar.link) {
        const l = this.pickLink(ar)
        if (l) void this.kick(ar)
        else if (now - ar.startedAt > ar.patienceMs && ar.received === 0) this.fail(ar, new Error('unreachable'))
      }
    }
    if (changed) this.emit()
  }

  private attach(link: Link) {
    const peer = link.conn.peer
    const orig = peer.emit
    peer.emit = (ev: string, ...args: any[]) => {
      if (ev === 'data') {
        const d = args[0]
        if (d && d.length > 1 && d[0] === MAGIC) {
          this.onFrame(link, d instanceof Uint8Array ? d : new Uint8Array(d))
          return true
        }
      }
      return orig.call(peer, ev, ...args)
    }
    const hello = () => {
      void this.sendFrame(link, encodeJSON({ t: 'hello', user: this.self.id, name: this.self.name })).catch(() => {})
      this.sendHave(link)
    }
    if (link.conn.connected) hello()
    else peer.once('connect', hello)
  }

  private linkFor(userId: string): Link | undefined {
    for (const l of this.links.values()) if (l.userId === userId && l.conn.connected && !l.conn.closed) return l
    return undefined
  }

  /** Owner first, then any holder of the hash; users waiting on a relink only as a last resort. */
  private pickLink(ar: ActiveReq, exclude?: string): Link | undefined {
    const ids = [ar.ownerId, ...(ar.req.hash ? this.holders(ar.req.hash) : [])].filter((id) => id !== exclude && !ar.bad.has(id))
    for (const id of ids) if (!ar.skip.has(id)) {
      const l = this.linkFor(id)
      if (l) return l
    }
    for (const id of ids) {
      const l = this.linkFor(id)
      if (l) return l
    }
    return undefined
  }

  /** Drop the current source and try another one; false if nobody else can serve right now. */
  private failover(ar: ActiveReq, mark: Set<string>): boolean {
    const cur = ar.link
    if (cur?.userId) mark.add(cur.userId)
    const next = this.pickLink(ar, cur?.userId)
    if (!next) return false
    if (cur) void this.sendFrame(cur, encodeJSON({ t: 'cancel', id: ar.id })).catch(() => {})
    ar.link = undefined
    void this.kick(ar)
    return true
  }

  private linkDown(l: Link) {
    for (const [k, st] of this.serving) if (k.startsWith(l.peerId + ':')) st.cancelled = true
    this.waiting = this.waiting.filter((w) => w.link !== l)
  }

  private async sendFrame(link: Link, frame: Uint8Array) {
    const peer = link.conn.peer
    const ch: RTCDataChannel | undefined = peer?._channel
    if (!link.conn.connected || link.conn.closed || !ch || ch.readyState !== 'open') throw new Error('link closed')
    if (ch.bufferedAmount > HIGH_WATER) await this.drain(ch)
    peer.send(frame)
  }

  private drain(ch: RTCDataChannel) {
    return new Promise<void>((resolve, reject) => {
      ch.bufferedAmountLowThreshold = LOW_WATER
      const cleanup = () => {
        clearInterval(iv)
        ch.removeEventListener('bufferedamountlow', onLow)
      }
      const onLow = () => {
        cleanup()
        resolve()
      }
      const iv = setInterval(() => {
        if (ch.readyState !== 'open') {
          cleanup()
          reject(new Error('link closed'))
        } else if (ch.bufferedAmount <= LOW_WATER) onLow()
      }, 100)
      ch.addEventListener('bufferedamountlow', onLow)
    })
  }

  // ---- incoming ----
  private onFrame(link: Link, buf: Uint8Array) {
    try {
      if (buf[1] === K_JSON) this.onMessage(link, JSON.parse(dec.decode(buf.subarray(2))) as Wire)
      else if (buf[1] === K_DATA) {
        const { id, offset, bytes } = decodeData(buf)
        this.onData(link, id, offset, bytes)
      }
    } catch (e) {
      console.warn('[gooseboard] bad frame', e)
    }
  }

  private onMessage(link: Link, msg: Wire) {
    switch (msg.t) {
      case 'hello':
        link.userId = msg.user
        link.name = msg.name
        this.emit()
        break
      case 'have':
        link.have = new Set(msg.hashes)
        link.aliases = msg.aliases
        this.emit()
        break
      case 'get':
        void this.serve(link, msg.id, msg.req)
        break
      case 'cancel':
        {
          const st = this.serving.get(`${link.peerId}:${msg.id}`)
          if (st) st.cancelled = true
          this.waiting = this.waiting.filter((w) => !(w.link === link && w.id === msg.id))
        }
        break
      case 'meta':
      case 'end':
      case 'err':
      case 'wait': {
        const ar = this.reqs.get(msg.id)
        if (!ar || ar.link !== link) return
        if (msg.t === 'meta') {
          ar.meta = msg.meta
          ar.h.onMeta?.(msg.meta)
          ar.h.onState?.('active')
        } else if (msg.t === 'wait') {
          if (!this.failover(ar, ar.skip)) ar.h.onState?.('waiting-relink')
        } else if (msg.t === 'err') {
          if (msg.code === 'canceled') this.fail(ar, new CanceledBy(link.name ?? 'a peer'))
          else if (!this.failover(ar, ar.bad)) this.fail(ar, new Error(msg.code === 'notfound' ? 'not found' : (msg.msg ?? 'failed')))
        } else void ar.chain.then(() => this.finish(ar))
        break
      }
    }
  }

  private onData(link: Link, id: number, offset: number, bytes: Uint8Array) {
    const ar = this.reqs.get(id)
    if (!ar || ar.link !== link || ar.settled) return
    if (offset !== ar.received) return // duplicate or gap after a resume: owner restarts from `from`
    ar.received += bytes.length
    ar.chain = ar.chain.then(() => ar.h.onData?.(offset, bytes)).catch((e) => this.fail(ar, e))
  }

  // ---- requesting (this peer wants bytes owned by `ownerId`, from them or a holder) ----
  request(ownerId: string, req: GetReq, h: Handlers, opts: { patienceMs?: number } = {}): ReqHandle {
    const id = this.nextId++ >>> 0
    let resolve!: (m: Meta | undefined) => void
    let reject!: (e: Error) => void
    const done = new Promise<Meta | undefined>((a, b) => {
      resolve = a
      reject = b
    })
    const ar: ActiveReq = {
      id,
      ownerId,
      req,
      h,
      received: req.from ?? 0,
      chain: Promise.resolve(),
      settled: false,
      bad: new Set(),
      skip: new Set(),
      local: ownerId === this.self.id || ((req.op === 'file' || req.op === 'preview') && !!req.hash && this.mirror.has(req.hash, this.board)),
      startedAt: Date.now(),
      patienceMs: opts.patienceMs ?? (req.op === 'file' ? Infinity : 15000),
      resolve,
      reject,
    }
    this.reqs.set(id, ar)
    void this.kick(ar)
    done.catch(() => {})
    return { done, cancel: () => this.cancelReq(ar) }
  }

  private async kick(ar: ActiveReq): Promise<void> {
    if (ar.settled) return
    if (ar.local) return this.runLocal(ar)
    const link = this.pickLink(ar)
    if (!link) {
      ar.h.onState?.('waiting-owner')
      return
    }
    ar.link = link
    ar.h.onState?.('connecting')
    try {
      const { alias: _alias, ...req } = ar.req
      await this.sendFrame(link, encodeJSON({ t: 'get', id: ar.id, req: { ...req, from: ar.received } }))
    } catch {
      ar.link = undefined
    }
  }

  private async runLocal(ar: ActiveReq): Promise<void> {
    try {
      const r = await this.resolve(ar.req)
      if (!r || r === 'relink') throw new Error(r ? 'needs relink' : 'not found')
      ar.meta = { name: r.name, size: r.size, mime: r.mime }
      ar.h.onMeta?.(ar.meta)
      ar.h.onState?.('active')
      const ok = await this.pump(r, ar.received, ar.req.to, async (off, bytes) => {
        ar.received = off + bytes.length
        await ar.h.onData?.(off, bytes)
      }, () => ar.settled)
      if (ok) this.finish(ar)
    } catch (e) {
      // our mirrored copy vanished or went stale: fetch from the owner/holders instead
      if (ar.ownerId !== this.self.id && !ar.settled) {
        ar.local = false
        return this.kick(ar)
      }
      this.fail(ar, e as Error)
    }
  }

  private cancelReq(ar: ActiveReq) {
    if (ar.settled) return
    if (ar.link) void this.sendFrame(ar.link, encodeJSON({ t: 'cancel', id: ar.id })).catch(() => {})
    this.fail(ar, new Error('canceled'))
  }

  private finish(ar: ActiveReq) {
    if (ar.settled) return
    ar.settled = true
    this.reqs.delete(ar.id)
    ar.resolve(ar.meta)
  }

  private fail(ar: ActiveReq, e: Error) {
    if (ar.settled) return
    ar.settled = true
    this.reqs.delete(ar.id)
    ar.reject(e)
  }

  // ---- serving (this peer owns the bytes) ----
  private async resolve(req: GetReq): Promise<Resolved | 'relink' | null> {
    const miss = () => (this.lookup(req.key) ? ('relink' as const) : null)
    if ((req.op === 'file' || req.op === 'preview') && req.hash) {
      let b = await this.mirror.get(req.hash, this.board)
      let e: { name: string; mime: string } | undefined = this.mirror.entry(req.hash)
      if (!b) ({ blob: b, e } = (await this.partial.servable(req.hash, this.board)) ?? { blob: null, e: undefined })
      if (b && e && req.op === 'preview') return this.resolvePreview(req.hash, b, e.name)
      const blob = b
      if (blob && e) return { name: e.name, size: blob.size, mime: e.mime, mirror: true, read: (a, c) => blob.slice(a, c).arrayBuffer() }
    }
    if (req.kind === 'file') {
      const f = await this.sources.getFile(req.key)
      if (!f) return miss()
      return this.resolveFile(req, f)
    }
    const dir = await this.sources.getDir(req.key)
    if (!dir) return miss()
    if (req.op === 'list') {
      const bytes = enc.encode(JSON.stringify(await dir.list(req.path ?? '')))
      return { name: 'list.json', size: bytes.length, mime: 'application/json', read: async (a, b) => bytes.slice(a, b).buffer as ArrayBuffer }
    }
    let f: File
    try {
      f = await dir.getFile(req.path ?? '')
    } catch {
      return null
    }
    return this.resolveFile(req, f)
  }

  private async resolveFile(req: GetReq, f: File): Promise<Resolved | null> {
    if (req.op === 'thumb') {
      const ck = `${req.key}\0${req.path ?? ''}`
      let t = this.thumbCache.get(ck)
      if (t === undefined) {
        t = await makeThumb(f)
        this.thumbCache.set(ck, t)
        if (this.thumbCache.size > 300) this.thumbCache.delete(this.thumbCache.keys().next().value!)
      }
      if (!t) return null
      const blob = t
      return { name: 'thumb.jpg', size: blob.size, mime: 'image/jpeg', read: (a, b) => blob.slice(a, b).arrayBuffer() }
    }
    if (req.op === 'preview') return this.resolvePreview(`${req.key}\0${req.path ?? ''}`, f, f.name)
    return { name: f.name, size: f.size, mime: mimeOf(f.name, f.type), read: (a, b) => f.slice(a, b).arrayBuffer() }
  }

  private async resolvePreview(ck: string, src: Blob, name: string): Promise<Resolved | null> {
    let p = this.previewCache.get(ck)
    if (!p) {
      p = makePreview(src, name)
      this.previewCache.set(ck, p)
      if (this.previewCache.size > 60) this.previewCache.delete(this.previewCache.keys().next().value!)
    }
    const blob = await p
    if (!blob) return null
    return { name: 'preview', size: blob.size, mime: blob.type, read: (a, b) => blob.slice(a, b).arrayBuffer() }
  }

  /** Reads `r` (up to `to`) in big blocks and hands out frame-sized pieces. Returns false if cancelled. */
  private async pump(
    r: Resolved,
    from: number,
    to: number | undefined,
    send: (offset: number, bytes: Uint8Array) => Promise<void>,
    cancelled: () => boolean,
  ): Promise<boolean> {
    const end = Math.min(to ?? r.size, r.size)
    let off = from
    while (off < end) {
      if (cancelled()) return false
      const block = new Uint8Array(await r.read(off, Math.min(off + BLOCK, end)))
      if (block.length === 0) throw new Error('short read')
      for (let p = 0; p < block.length; p += PAYLOAD) {
        if (cancelled()) return false
        await send(off + p, block.subarray(p, Math.min(p + PAYLOAD, block.length)))
      }
      off += block.length
    }
    return true
  }

  private async serve(link: Link, id: number, req: GetReq) {
    const skey = `${link.peerId}:${id}`
    const st: { cancelled: boolean; tid?: string; byMe?: boolean } = { cancelled: false }
    this.serving.set(skey, st)
    const tid = `up:${skey}`
    let tracked = false
    let streamTid = ''
    let sent = req.from ?? 0
    let fromMirror = false
    const send = (m: Wire) => this.sendFrame(link, encodeJSON(m))
    try {
      const r = await this.resolve(req)
      if (r === 'relink') return void (await this.needRelink(link, id, req, sent))
      if (!r) return void (await send({ t: 'err', id, code: 'notfound' }))
      fromMirror = !!r.mirror
      await send({ t: 'meta', id, meta: { name: r.name, size: r.size, mime: r.mime } })
      if (req.op === 'file' && req.stream) {
        // ranges of one stream, reported together: active while any is being sent
        const tid = `up:stream:${link.peerId}:${req.sid ?? req.key}`
        if (this.streamsStopped.has(tid)) return void (await send({ t: 'err', id, code: 'canceled', msg: `Canceled by ${this.self.name}` }))
        streamTid = st.tid = tid
        const n = (this.streamsOut.get(streamTid) ?? 0) + 1
        this.streamsOut.set(streamTid, n)
        if (n === 1) {
          const prev = this.transfers.getSnapshot().find((t) => t.id === streamTid)
          if (prev) this.transfers.patch(streamTid, { state: 'active' })
          else {
            const t = streamTid
            this.transfers.add({ id: t, dir: 'up', name: r.name, size: r.size, done: 0, state: 'active', peerName: link.name ?? 'a peer', startedAt: Date.now(), cancel: () => this.stopStream(t) })
          }
        }
      } else if (req.op === 'file') {
        tracked = true
        this.transfers.add({
          id: tid, dir: 'up', name: r.name, size: r.size, done: sent, state: 'active',
          peerName: link.name ?? 'a peer', startedAt: Date.now(), cancel: () => ((st.cancelled = st.byMe = true), this.transfers.patch(tid, { state: 'canceled' })),
        })
      }
      const ok = await this.pump(
        r,
        sent,
        req.to,
        async (off, bytes) => {
          await this.sendFrame(link, encodeData(id, off, bytes))
          if (streamTid) {
            const t = this.transfers.getSnapshot().find((x) => x.id === streamTid)
            if (t) this.transfers.patch(streamTid, { done: Math.min(t.size, t.done + bytes.length) })
          }
          sent = off + bytes.length
          if (tracked) this.transfers.patch(tid, { done: sent })
        },
        () => st.cancelled,
      )
      if (ok) {
        await send({ t: 'end', id })
        if (tracked) this.transfers.patch(tid, { state: 'done', done: r.size })
      } else {
        if (tracked) this.transfers.patch(tid, { state: 'canceled' })
        // canceled here, not by the receiver: tell them, so they stop waiting (and don't ask someone else)
        if (st.byMe) await send({ t: 'err', id, code: 'canceled', msg: `Canceled by ${this.self.name}` }).catch(() => {})
      }
    } catch (e) {
      const name = (e as Error)?.name
      if ((name === 'NotFoundError' || name === 'NotReadableError') && !st.cancelled && !fromMirror) {
        // file moved/changed since it was shared: ask the owner to relink and resume from `sent`
        this.sources.forget(req.key)
        if (tracked) this.transfers.patch(tid, { state: 'waiting-relink' })
        await this.needRelink(link, id, req, sent).catch(() => {})
      } else {
        if (tracked) this.transfers.patch(tid, { state: 'error', error: String((e as Error)?.message ?? e) })
        await send({ t: 'err', id, code: 'failed', msg: String((e as Error)?.message ?? e) }).catch(() => {})
      }
    } finally {
      this.serving.delete(skey)
      if (streamTid) {
        const n = (this.streamsOut.get(streamTid) ?? 1) - 1
        if (n > 0) this.streamsOut.set(streamTid, n)
        else {
          this.streamsOut.delete(streamTid)
          this.transfers.patch(streamTid, { state: this.streamsStopped.has(streamTid) ? 'canceled' : 'done' })
        }
      }
    }
  }

  /** Stops one peer's stream: the ranges being sent now, and any it asks for later. */
  private stopStream(tid: string) {
    this.streamsStopped.add(tid)
    this.serving.forEach((st) => st.tid === tid && (st.cancelled = st.byMe = true))
    this.transfers.patch(tid, { state: 'canceled' })
  }

  private async needRelink(link: Link, id: number, req: GetReq, from: number) {
    const info = this.lookup(req.key)
    this.waiting.push({ link, id, req: { ...req, from } })
    const p = this.pending.get(req.key) ?? { key: req.key, kind: req.kind, name: info?.name ?? 'a shared item', askedBy: [] }
    const who = link.name ?? 'someone'
    if (!p.askedBy.includes(who)) p.askedBy.push(who)
    this.pending.set(req.key, p)
    this.emit()
    await this.sendFrame(link, encodeJSON({ t: 'wait', id, reason: 'relink' }))
  }

  /** Call after the owner re-selected a file/folder: resumes everyone who was waiting. */
  relinked(key: string) {
    this.pending.delete(key)
    const mine = this.waiting.filter((w) => w.req.key === key)
    this.waiting = this.waiting.filter((w) => w.req.key !== key)
    mine.forEach((w) => void this.serve(w.link, w.id, w.req))
    this.emit()
  }

  dismissPending(key: string) {
    this.pending.delete(key)
    this.emit()
  }

  /** Mark a key's thumbnails stale (e.g. after relinking a different file). */
  dropThumbs(key: string) {
    for (const k of [...this.thumbCache.keys()]) if (k.startsWith(key + '\0')) this.thumbCache.delete(k)
    for (const k of [...this.previewCache.keys()]) if (k.startsWith(key + '\0')) this.previewCache.delete(k)
  }
}
