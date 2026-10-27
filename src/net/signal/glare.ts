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
