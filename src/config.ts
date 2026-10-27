/**
 * Serverless signaling (see src/net/signal): peers find each other through public Nostr
 * relays and WebTorrent trackers, all used at once, so any of them being down is fine.
 * Signaling only carries the (encrypted) WebRTC handshake; board data flows peer-to-peer.
 * Checked 2026-10-26: each one below delivered a test message between two clients;
 * relay.snort.social (no delivery), tracker.btorrent.xyz and relay.nostr.bg (unreachable) did not.
 * offchain.pub dropped 2026-10-27 (connection refused).
 */
export const NOSTR_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
]

export const TORRENT_TRACKERS: string[] = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
]

/**
 * STUN only (no TURN): some strict NATs will fail to connect.
 * Google primary, backups spread across providers. Kept at 4: browsers
 * warn that 5+ ICE servers slows candidate gathering.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
]

export const ROOM_PREFIX = 'gooseboard:'

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 4

/** Wire frame sizes for the file-transfer channel. */
export const FRAME_SIZE = 16 * 1024
export const HIGH_WATER = 1024 * 1024
export const LOW_WATER = 256 * 1024

/** Files up to this size replicate to every peer's IndexedDB cache; larger ones are fetched on request. */
export const SMALL_FILE = 2 * 1024 * 1024
