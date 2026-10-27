import { sha256, Transport, Wire, type Endpoint } from './core'

/** Offers per announce: the tracker hands each one to a different random peer in the swarm. */
const FANOUT = 10
const REANNOUNCE_MS = 50_000

const latin1 = (b: Uint8Array) => String.fromCharCode(...b)
const randomId = () => latin1(crypto.getRandomValues(new Uint8Array(20)))

type Offer = { offer: { type: 'offer'; sdp: string }; offer_id: string }

/**
 * Signaling over public WebTorrent trackers. Each topic is a swarm (info_hash derived from
 * the topic); joining = announcing with no offers. To broadcast, we announce with FANOUT
 * "offers" whose sdp field carries our batch, and the tracker relays one to each other peer.
 * Rooms are small, so FANOUT covers everyone; we never answer, so no WebRTC is set up here.
 */
export class TrackerSignal extends Transport {
  private wires: Wire[]
  private peerId = randomId()
  private hashes = new Map<string, Promise<string>>()
  private byHash = new Map<string, string>()

  constructor(trackers: string[], onStatus: () => void) {
    super(onStatus)
    this.wires = trackers.map((url) => {
      const wire: Wire = new Wire(url, {
        open: () => {
          this.topics.forEach((t) => void this.announce(t, [], wire, 'started'))
          this.statusChanged()
        },
        close: () => this.statusChanged(),
        message: (d) => this.onTracker(d),
      })
      return wire
    })
    // trackers drop peers that stop announcing
    setInterval(() => this.topics.forEach((t) => void this.announce(t, [])), REANNOUNCE_MS)
  }

  endpoints(): Endpoint[] {
    return this.wires.map((w) => ({ url: w.url, open: w.open }))
  }

  private infoHash(topic: string) {
    let h = this.hashes.get(topic)
    if (!h) {
      h = sha256('gooseboard-signal:' + topic).then((b) => {
        const x = latin1(b.subarray(0, 20))
        this.byHash.set(x, topic)
        return x
      })
      this.hashes.set(topic, h)
    }
    return h
  }

  private async announce(topic: string, offers: Offer[], only?: Wire, event?: string) {
    const info_hash = await this.infoHash(topic)
    const msg = {
      action: 'announce', info_hash, peer_id: this.peerId, numwant: offers.length || FANOUT,
      uploaded: 0, downloaded: 0, left: 1, offers, ...(event ? { event } : {}),
    }
    ;(only ? [only] : this.wires).forEach((w) => w.send(msg))
  }

  protected join(topic: string) {
    void this.announce(topic, [], undefined, 'started')
  }

  protected leave(topic: string) {
    void this.announce(topic, [], undefined, 'stopped')
  }

  protected send(topic: string, batch: unknown[]) {
    const sdp = JSON.stringify(batch)
    const offers = Array.from({ length: FANOUT }, (): Offer => ({ offer: { type: 'offer', sdp }, offer_id: randomId() }))
    void this.announce(topic, offers)
  }

  private onTracker(raw: string) {
    let m: any
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (m?.action !== 'announce' || !m.offer || m.peer_id === this.peerId) return
    const topic = this.byHash.get(m.info_hash)
    if (!topic || typeof m.offer.sdp !== 'string') return
    try {
      this.deliver(topic, JSON.parse(m.offer.sdp))
    } catch {
      /* a real WebTorrent peer on a colliding hash: ignore */
    }
  }
}
