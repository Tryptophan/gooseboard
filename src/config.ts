/**
 * Public y-webrtc signaling servers, used by dev and production builds alike. Signaling
 * only carries the WebRTC handshake; board data flows peer-to-peer. y-webrtc connects to
 * ALL of these at once, so any single one being down is fine.
 */
// Checked 2026-10-26: signaling.yjs.dev (no DNS) and both *.herokuapp.com apps ("No such app")
// are dead, so they are not listed. This is y-webrtc's own default.
export const SIGNALING_URLS: string[] = ['wss://y-webrtc-eu.fly.dev']

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
