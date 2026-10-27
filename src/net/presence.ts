import { WebrtcProvider } from 'y-webrtc'
import * as Y from 'yjs'
import { ICE_SERVERS, ROOM_PREFIX } from '../config'
import type { Profile } from '../lib/storage'
import type { PresenceUser } from '../model/types'
import { installSignaling, SIGNAL_URLS } from './signal'
import { dropIfStuck, fixGlare } from './signal/glare'

/**
 * Who is on a board right now, visible without opening it. The board room itself would sync the
 * whole doc to anyone joining, so each board also has a tiny awareness-only room (empty doc).
 * People on the board announce themselves there; the home screen joins it silently and listens.
 * They also carry the board's current name, so a rename by anyone reaches everyone's board list.
 * Same password as the board room, so only link holders can see who's in it.
 */
const PREFIX = ROOM_PREFIX + 'presence:'

type Listener = () => void

interface Room {
  doc: Y.Doc
  provider: WebrtcProvider
  refs: number
  /** board sessions announcing from this tab; the latest one is shown */
  here: Here[]
  users: PresenceUser[]
  /** board name as announced by the people on it */
  name: string
  listeners: Set<Listener>
  timer?: ReturnType<typeof setTimeout>
}

interface Here {
  profile: Profile
  name: () => string
}

export interface BoardPresence {
  users: PresenceUser[]
  name: string
}

const rooms = new Map<string, Room>()

function open(id: string): Room {
  let r = rooms.get(id)
  if (!r) {
    installSignaling()
    const doc = new Y.Doc()
    const provider = new WebrtcProvider(PREFIX + id, doc, { signaling: SIGNAL_URLS, password: id, peerOpts: { config: { iceServers: ICE_SERVERS } } })
    provider.awareness.setLocalState(null)
    const room: Room = { doc, provider, refs: 0, here: [], users: [], name: '', listeners: new Set() }
    provider.awareness.on('change', () => {
      const seen = new Map<string, PresenceUser>()
      let name = ''
      provider.awareness.getStates().forEach((st, clientId) => {
        const { user: u, board } = st as { user?: PresenceUser; board?: unknown }
        if (clientId !== doc.clientID && typeof board === 'string' && board && !name) name = board.slice(0, 200)
        if (clientId !== doc.clientID && u?.id && !seen.has(u.id)) seen.set(u.id, { id: u.id, name: String(u.name ?? ''), color: String(u.color ?? '') })
      })
      room.users = [...seen.values()]
      room.name = name
      room.listeners.forEach((l) => l())
    })
    void Promise.resolve((provider as any).key).then(() => hookGlare(provider))
    r = room
    rooms.set(id, r)
  }
  if (r.timer) clearTimeout(r.timer)
  r.timer = undefined
  r.refs++
  return r
}

/** Same glare and stuck-handshake fixes the board room gets (see signal/glare). */
function hookGlare(provider: WebrtcProvider) {
  const map: Map<string, any> | undefined = (provider as any).room?.webrtcConns
  if (!map) return
  const set = map.set.bind(map)
  map.set = (peerId: string, conn: any) => {
    set(peerId, conn)
    fixGlare(conn, provider)
    dropIfStuck(conn)
    return map
  }
  map.forEach((conn) => {
    fixGlare(conn, provider)
    dropIfStuck(conn)
  })
}

function close(id: string) {
  const r = rooms.get(id)
  if (!r || --r.refs > 0) return
  // y-webrtc frees a room name asynchronously; home -> board reuses the room if quick enough
  r.timer = setTimeout(() => {
    if (r.refs > 0) return
    rooms.delete(id)
    r.provider.destroy()
    r.doc.destroy()
  }, 400)
}

function announce(r: Room) {
  const h = r.here[r.here.length - 1]
  const p = h?.profile
  r.provider.awareness.setLocalState(p ? { user: { id: p.id, name: p.name, color: p.color }, board: h.name() } : null)
}

/** Board sessions: show this person (and the board's name) as on the board until released. */
export function joinPresence(id: string, profile: Profile, name: () => string) {
  const r = open(id)
  const h: Here = { profile, name }
  r.here.push(h)
  announce(r)
  return {
    /** call after the profile (shared, mutated in place) or the board name changes */
    refresh: () => announce(r),
    release: () => {
      r.here.splice(r.here.indexOf(h), 1)
      announce(r)
      close(id)
    },
  }
}

export type PresenceHandle = ReturnType<typeof joinPresence>

/** Home screen: listen to who is on a board without appearing there. */
export function watchPresence(id: string, onChange: (p: BoardPresence) => void): () => void {
  const r = open(id)
  const l = () => onChange({ users: r.users, name: r.name })
  r.listeners.add(l)
  l()
  return () => {
    r.listeners.delete(l)
    close(id)
  }
}
