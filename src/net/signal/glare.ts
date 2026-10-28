import { WebrtcConn } from 'y-webrtc'

/**
 * Fixes y-webrtc's glare handling. When two peers announce at the same moment, both dial.
 * The tie-break rejects one offer, but the loser then feeds the winner's offer into its own
 * *initiator* simple-peer, which can't answer it: both sides end up "connected" on different
 * halves of two connections and nothing gets through. Instead, an initiator that receives an
 * offer (only ever glare: simple-peer never sends offers to an initiator otherwise) is
 * dropped quietly and the offer is answered by a fresh non-initiator connection.
 */
export function fixGlare(conn: any, provider: any) {
  const peer = conn.peer
  if (!peer?.initiator || peer.__glareFixed) return
  peer.__glareFixed = true
  const signal = peer.signal.bind(peer)
  peer.signal = (data: any) => {
    const room = provider.room
    const via = provider.signalingConns?.find((c: any) => c.connected) ?? provider.signalingConns?.[0]
    if (data?.type !== 'offer' || conn.connected || !room || !via) return signal(data)
    // detach first: y-webrtc's close handler would delete whatever sits under this peer id
    peer.removeAllListeners('close')
    peer.removeAllListeners('error')
    peer.removeAllListeners('signal')
    conn.closed = true
    peer.destroy()
    const fresh = new WebrtcConn(via, false, conn.remotePeerId, room)
    room.webrtcConns.set(conn.remotePeerId, fresh)
    fresh.peer.signal(data)
  }
}

/**
 * A handshake whose offer or answer got lost leaves a connection that never opens, and y-webrtc
 * ignores announces from a peer it already has a connection for. Destroy it after a while: y-webrtc
 * then forgets the peer and re-announces, so the next round can dial again.
 */
export function dropIfStuck(conn: any) {
  if (conn.__stuckTimer) return
  for (const c of live) if (c.closed) live.delete(c)
  live.add(conn)
  conn.__stuckTimer = setTimeout(() => {
    if (!conn.connected && !conn.closed) conn.peer?.destroy()
  }, 30_000)
}

/** Every peer connection seen by dropIfStuck (board and presence rooms), for dropAll. */
const live = new Set<any>()

/** Destroys every peer connection: y-webrtc forgets those peers and re-announces, so both sides dial afresh. */
export function dropAll() {
  live.forEach((c) => c.closed || c.peer?.destroy())
  live.clear()
}
