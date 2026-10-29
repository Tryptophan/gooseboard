import { isValidPacket, QWBPConnection, QWBPTimeoutError } from 'qwbp'
import { getProfile } from '../lib/storage'
import { mesh } from './signal'
import type { MeshChannel, MeshMsg } from './signal/mesh'

/**
 * Links a device that can't reach any relay (a LAN with no internet) by QR codes, using QWBP:
 * each side shows a ~100-byte code and scans the other's, which is enough to open a WebRTC data
 * channel with no signaling server. That channel only bootstraps: it joins the signaling mesh
 * (see signal/mesh), so y-webrtc dials its usual board link across it, and once that link says
 * hello this one closes. From then on the mesh keeps introducing everyone to everyone.
 */

export interface BoardRef {
  id: string
  name: string
}

type Wire =
  // who I am, and where I started; `got`: I have yours (sent until they say they have mine)
  | { t: 'hi'; user: string; name: string; board?: BoardRef; got: boolean }
  | { t: 'mesh'; m: MeshMsg }
  // handed over to the board link: close this one
  | { t: 'bye' }
  // both devices are on different boards: "I'll come to yours" / "I'm staying" / "come over"
  | { t: 'join' }
  | { t: 'stay' }
  | { t: 'ok' }

export type LinkState =
  | { s: 'starting' }
  /** `qr`: my code to show; `scanned`: I have read theirs */
  | { s: 'ready'; qr: Uint8Array; scanned: boolean }
  | { s: 'connecting' }
  /** both of us started from different boards: join theirs, or stay? `waiting`: I chose, they haven't */
  | { s: 'choose'; peer: string; board: BoardRef; waiting: boolean }
  /** linked: `join` means open `board` here */
  | { s: 'done'; peer: string; board: BoardRef; join: boolean }
  | { s: 'failed'; msg: string }

/** How long the codes stay valid. */
const TIMEOUT_MS = 10 * 60_000

/** Links still open: starting one drops any not yet linked (a linked one closes once handed over). */
const open = new Set<QrLink>()

export class QrLink {
  state: LinkState = { s: 'starting' }
  private qwbp: QWBPConnection
  private listeners = new Set<() => void>()
  private ch: RTCDataChannel | null = null
  private hop: MeshChannel | null = null
  private unhop: (() => void) | null = null
  private unwatch: (() => void) | null = null
  private me = getProfile()
  private peer?: { user: string; name: string; board?: BoardRef }
  private choice?: 'join' | 'stay'
  private theyStay = false
  private closed = false
  private hiTimer: ReturnType<typeof setInterval> | undefined

  /** `board`: the board this device started from (none from the home screen) */
  constructor(private board?: BoardRef) {
    open.forEach((l) => l.cancel())
    open.add(this)
    this.qwbp = new QWBPConnection({
      // no internet: host candidates are all there is, and STUN would only stall gathering
      iceServers: [],
      timeout: TIMEOUT_MS,
      onDataChannel: (ch) => this.opened(ch),
      onError: (e) => this.failed(e),
    })
    void this.start()
  }

  private async start() {
    try {
      await this.qwbp.initialize()
      if (!this.closed) this.set({ s: 'ready', qr: this.qwbp.getQRPayload(), scanned: false })
    } catch (e) {
      this.failed(e)
    }
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  getState = () => this.state

  private set(s: LinkState) {
    this.state = s
    this.listeners.forEach((l) => l())
  }

  private failed(e: unknown) {
    if (this.closed || this.state.s === 'done') return this.teardown()
    const msg =
      e instanceof QWBPTimeoutError
        ? 'The codes expired. Start again to get new ones.'
        : e instanceof Error && /gathering/i.test(e.message)
          ? 'No network found. Join the same Wi-Fi or hotspot as the other device.'
          : 'Couldn’t connect. Both devices need to be on the same network.'
    this.set({ s: 'failed', msg })
    this.teardown()
  }

  /** A code read by the camera or from a photo: false if it isn't the other device's. */
  async scan(bytes: Uint8Array): Promise<boolean> {
    const st = this.state
    if (st.s !== 'ready' || st.scanned) return st.s !== 'ready'
    if (!isValidPacket(bytes)) return false
    // my own code (seen in a mirror, or a photo of this screen) would wedge QWBP: it keeps the first scan
    if (bytes.length === st.qr.length && bytes.every((b, i) => b === st.qr[i])) return false
    try {
      this.set({ ...st, scanned: true })
      // my code stays up: the channel opens once they have scanned it too
      await this.qwbp.processScannedPayload(bytes)
      return true
    } catch {
      if (this.state.s === 'ready') this.set({ ...this.state, scanned: false })
      return false
    }
  }

  private opened(ch: RTCDataChannel) {
    // the answering side also gets the offerer's "init" channel (only there to gather candidates)
    if (ch.label !== 'qwbp' || this.ch) return
    if (this.closed) return ch.close()
    this.ch = ch
    this.set({ s: 'connecting' })
    ch.addEventListener('message', (e) => {
      try {
        if (typeof e.data === 'string') this.onMessage(JSON.parse(e.data) as Wire)
      } catch {
        /* not ours */
      }
    })
    ch.addEventListener('close', () => {
      if (this.state.s !== 'done' && this.state.s !== 'failed') this.set({ s: 'failed', msg: 'The other device closed the link.' })
      this.teardown()
    })
    this.hop = { send: (m) => this.send({ t: 'mesh', m }) }
    this.unhop = mesh.add(this.hop)
    // the answering side hears about the channel only once it's open, so what the other side sent
    // first can be gone before anyone listens: repeat hi until they confirm they have it
    this.sayHi()
    this.hiTimer = setInterval(this.sayHi, 700)
  }

  private sayHi = () => this.send({ t: 'hi', user: this.me.id, name: this.me.name, board: this.board, got: !!this.peer })

  private send(w: Wire) {
    if (this.ch?.readyState === 'open') this.ch.send(JSON.stringify(w))
  }

  private onMessage(w: Wire) {
    switch (w.t) {
      case 'mesh':
        if (this.hop) mesh.receive(this.hop, w.m)
        break
      case 'hi':
        if (w.got) clearInterval(this.hiTimer)
        if (!this.peer) {
          this.peer = { user: w.user, name: w.name, board: w.board }
          if (this.hop) {
            this.hop.user = w.user
            mesh.identified()
          }
          this.decide()
        }
        if (!w.got) this.sayHi()
        break
      case 'bye':
        this.teardown()
        break
      case 'join':
        // both chose to join: the one with the smaller id goes, the other stays to receive them
        if (this.choice !== 'join' || this.peer!.user < this.me.id) {
          this.send({ t: 'ok' })
          this.finish(false)
        }
        break
      case 'ok':
        this.finish(true)
        break
      case 'stay':
        this.theyStay = true
        if (this.choice === 'stay') this.bothStay()
        break
    }
  }

  private decide() {
    const mine = this.board
    const theirs = this.peer!.board
    if (!mine && !theirs) {
      this.set({ s: 'failed', msg: 'Neither device has a board open. Start from a board on one of them.' })
      return this.teardown()
    }
    if (!mine) return this.finish(true)
    if (!theirs || theirs.id === mine.id) return this.finish(false)
    this.set({ s: 'choose', peer: this.peer!.name, board: theirs, waiting: false })
  }

  /** In 'choose': go over to their board. */
  join() {
    if (this.state.s !== 'choose' || this.choice) return
    this.choice = 'join'
    this.set({ ...this.state, waiting: true })
    this.send({ t: 'join' })
  }

  /** In 'choose': keep my board (they may still come over to it). */
  stay() {
    if (this.state.s !== 'choose' || this.choice) return
    this.choice = 'stay'
    this.set({ ...this.state, waiting: true })
    this.send({ t: 'stay' })
    if (this.theyStay) this.bothStay()
  }

  private bothStay() {
    this.set({ s: 'failed', msg: 'You both stayed on your own boards.' })
    this.teardown()
  }

  private finish(join: boolean) {
    if (this.state.s === 'done') return
    const board = join ? this.peer!.board! : this.board!
    this.set({ s: 'done', peer: this.peer!.name, board, join })
    // hand over to the board link y-webrtc dials across the mesh; this one is only a bootstrap
    const user = this.peer!.user
    const check = () => {
      if (!mesh.hasUser(user, this.hop ?? undefined)) return
      this.unwatch?.()
      this.unwatch = null
      // a moment for anything still in flight across it; the other side may not notice a close for a while
      setTimeout(() => {
        this.send({ t: 'bye' })
        setTimeout(() => this.teardown(), 500)
      }, 3000)
    }
    this.unwatch = mesh.watch(check)
    check()
  }

  /** The dialog was closed: drop the attempt, unless it linked (then it closes itself once handed over). */
  cancel() {
    if (this.state.s !== 'done') this.teardown()
  }

  private teardown() {
    open.delete(this)
    clearInterval(this.hiTimer)
    this.unwatch?.()
    this.unwatch = null
    this.unhop?.()
    this.unhop = null
    if (this.closed) return
    this.closed = true
    this.qwbp.close()
  }
}
