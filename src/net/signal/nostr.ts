import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256, toHex, Transport, Wire, type Endpoint } from './core'

/** Ephemeral range (NIP-16): relays forward these to live subscribers and don't store them. */
const KIND = 29_573
const MAX_AGE_S = 60

interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

/**
 * Signaling over public Nostr relays: each batch is an ephemeral event tagged with a hash of
 * the topic, signed by a throwaway per-tab key. Every relay gets every event; duplicates
 * arriving from several relays are dropped by event id.
 */
export class NostrSignal extends Transport {
  private wires: Wire[]
  private sk = schnorr.utils.randomSecretKey()
  private pk = toHex(schnorr.getPublicKey(this.sk))
  private tags = new Map<string, Promise<string>>()
  private subs = new Map<string, string>()
  private seen = new Set<string>()

  constructor(relays: string[], onStatus: () => void) {
    super(onStatus)
    this.wires = relays.map((url) => {
      const wire: Wire = new Wire(url, {
        open: () => {
          // (re)subscribe on this relay only
          this.topics.forEach((t) => void this.req(t, wire))
          this.statusChanged()
        },
        close: () => this.statusChanged(),
        message: (d) => this.onRelay(d),
      })
      return wire
    })
  }

  endpoints(): Endpoint[] {
    return this.wires.map((w) => ({ url: w.url, open: w.open }))
  }

  private tag(topic: string) {
    let t = this.tags.get(topic)
    if (!t) {
      t = sha256('gooseboard-signal:' + topic).then(toHex)
      this.tags.set(topic, t)
    }
    return t
  }

  private async req(topic: string, only?: Wire) {
    const tag = await this.tag(topic)
    const sub = 'gb' + tag.slice(0, 16)
    this.subs.set(sub, topic)
    // limit 0: live events only. Some relays keep "ephemeral" events, and a replayed announce
    // makes both sides dial each other at once (glare), which y-webrtc doesn't recover from.
    const msg = ['REQ', sub, { kinds: [KIND], '#x': [tag], limit: 0 }]
    ;(only ? [only] : this.wires).forEach((w) => w.send(msg))
  }

  protected join(topic: string) {
    void this.req(topic)
  }

  protected leave(topic: string) {
    void this.tag(topic).then((tag) => {
      const sub = 'gb' + tag.slice(0, 16)
      this.subs.delete(sub)
      this.wires.forEach((w) => w.send(['CLOSE', sub]))
    })
  }

  protected send(topic: string, batch: unknown[]) {
    void this.tag(topic).then(async (tag) => {
      const ev = {
        pubkey: this.pk,
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND,
        tags: [['x', tag]],
        content: JSON.stringify(batch),
      }
      const id = await sha256(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))
      const signed: NostrEvent = { ...ev, id: toHex(id), sig: toHex(schnorr.sign(id, this.sk)) }
      this.wires.forEach((w) => w.send(['EVENT', signed]))
    })
  }

  private onRelay(raw: string) {
    let m: unknown
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(m) || m[0] !== 'EVENT') return
    const topic = this.subs.get(m[1])
    const ev = m[2] as NostrEvent
    if (!topic || !ev || ev.pubkey === this.pk || this.seen.has(ev.id)) return
    // a relay that stores ephemeral events anyway would replay stale announces
    if (Math.floor(Date.now() / 1000) - ev.created_at > MAX_AGE_S) return
    this.seen.add(ev.id)
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!)
    try {
      this.deliver(topic, JSON.parse(ev.content))
    } catch {
      /* not ours */
    }
  }
}
