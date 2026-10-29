import { decode, isValidPacket, QWBPConnection, QWBPTimeoutError } from 'qwbp'
import { diag } from '../lib/diag'
import { newBoardId } from '../lib/ids'
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
  // neither of us has a board: here's a new one for both
  | { t: 'new'; board: BoardRef }

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

/** Kinds of addresses in a code, for diagnostics (never the addresses themselves). */
function kinds(code: Uint8Array) {
  const out: Record<string, number> = {}
  for (const c of decode(code).candidates) {
    const k = `${c.ip.endsWith('.local') ? 'mdns' : c.ip.includes(':') ? 'ipv6' : 'ipv4'}/${c.protocol}`
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}
const mdnsOnly = (code: Uint8Array) => decode(code).candidates.every((c) => c.ip.endsWith('.local'))

/**
 * QWBP writes the other side's SDP session id as a full unsigned 64-bit number (from a hash of
 * its fingerprint). Firefox takes at most 2^63 - 1 and refuses the whole description otherwise,
 * so half of all links with Firefox failed. The id plays no part in security: clear its top bit.
 */
function fixSessionId(qwbp: QWBPConnection) {
  const pc = (qwbp as unknown as { pc: RTCPeerConnection | null }).pc
  if (!pc) return
  const set = pc.setRemoteDescription.bind(pc)
  pc.setRemoteDescription = (d: RTCSessionDescriptionInit) =>
    set(d.sdp ? { ...d, sdp: d.sdp.replace(/^o=(\S+) (\d+)/m, (_, user: string, id: string) => `o=${user} ${BigInt(id) & 0x7fffffffffffffffn}`) } : d)
}

/**
 * Only the offerer's addresses matter: the answerer rolls back the offer it made its code from,
 * and gathers again on new ports, so the addresses in its code are stale. The link works when the
 * answerer reaches the offerer (which learns the answerer's address from those checks). A device
 * capturing the camera has its real LAN address in its code (see the constructor); one without
 * may only have a hidden .local name. QWBP makes the larger DTLS fingerprint the offerer, so pick
 * a certificate whose fingerprint starts high when capturing and low when not: a device with a
 * camera then offers to one without. Two of a kind are left to chance, as before.
 */
async function steerRole(capturing: boolean, init: () => Promise<void>) {
  const gen = RTCPeerConnection.generateCertificate
  RTCPeerConnection.generateCertificate = async (alg) => {
    let cert = await gen.call(RTCPeerConnection, alg)
    for (let i = 0; i < 16; i++) {
      const fp = cert.getFingerprints?.().find((f) => f.algorithm === 'sha-256')?.value
      if (!fp || parseInt(fp.slice(0, 2), 16) >= 0x80 === capturing) break
      cert = await gen.call(RTCPeerConnection, alg)
    }
    return cert
  }
  try {
    await init()
  } finally {
    RTCPeerConnection.generateCertificate = gen
  }
}

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
  private mine?: Uint8Array
  private theirs?: Uint8Array

  /**
   * `board`: the board this device started from (none from the home screen). `camera`: the
   * camera being opened, waited for before the code is made: browsers hide a device's LAN address
   * behind a random .local name unless the page is capturing, and those names often can't be
   * resolved by the other device (Android, Linux), so with both sides hidden nothing connects.
   */
  constructor(
    private board?: BoardRef,
    private camera?: Promise<unknown>,
  ) {
    open.forEach((l) => l.cancel())
    open.add(this)
    this.qwbp = new QWBPConnection({
      // no internet: host candidates are all there is, and STUN would only stall gathering
      iceServers: [],
      // past QWBP's 4: TCP placeholders and extra interfaces (docker, VPN, cellular) can crowd out the LAN one
      maxCandidates: 6,
      timeout: TIMEOUT_MS,
      onDataChannel: (ch) => this.opened(ch),
      onError: (e) => this.failed(e),
    })
    void this.start()
  }

  private async start() {
    try {
      const capturing = this.camera ? await this.camera.then(() => true, () => false) : false
      if (this.closed) return
      await steerRole(capturing, () => this.qwbp.initialize())
      if (this.closed) return
      fixSessionId(this.qwbp)
      this.mine = this.qwbp.getQRPayload()
      diag('qrlink', 'code', { ...kinds(this.mine), capturing })
      this.set({ s: 'ready', qr: this.mine, scanned: false })
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
    // after the handover, the bootstrap closing is expected
    if (this.closed || this.state.s === 'done') return this.teardown()
    diag('qrlink', 'failed', { error: e, state: this.state.s, role: this.qwbp.assignedRole })
    const hidden = this.mine && this.theirs && mdnsOnly(this.mine) && mdnsOnly(this.theirs)
    const msg =
      e instanceof QWBPTimeoutError
        ? 'The codes expired. Start again to get new ones.'
        : e instanceof Error && /gathering/i.test(e.message)
          ? 'No network found. Join the same Wi-Fi or hotspot as the other device.'
          : hidden
            ? 'Couldn’t reach the other device: neither browser shared its local address. Allow camera access on at least one of them, then try again.'
            : 'Couldn’t connect. Check both devices are on the same Wi-Fi or hotspot, and that it lets devices see each other (guest networks often don’t).'
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
      this.theirs = bytes
      diag('qrlink', 'scanned', kinds(bytes))
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
    diag('qrlink', 'open', { role: this.qwbp.assignedRole })
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
      case 'new':
        if (this.peer && !this.board) this.finish(true, w.board)
        break
    }
  }

  private decide() {
    const mine = this.board
    const theirs = this.peer!.board
    if (!mine && !theirs) {
      // both came from the home screen: the one with the smaller id makes a board, and both open it
      if (this.me.id > this.peer!.user) return
      const board = { id: newBoardId(), name: '' }
      this.send({ t: 'new', board })
      return this.finish(true, board)
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

  private finish(join: boolean, board = join ? this.peer!.board! : this.board!) {
    if (this.state.s === 'done') return
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
