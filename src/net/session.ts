import { BoardStore } from '../model/board'
import { getProfile, type Profile } from '../lib/storage'
import { FileService } from './fileService'
import { Mirror } from './mirror'
import { P2P } from './p2p'
import { joinPresence, type PresenceHandle } from './presence'
import { LocalSources } from './sources'
import { FileSync } from './sync'
import { TransferStore } from './transfers'

/** One board's worth of live objects: CRDT doc, mesh networking, file serving. */
export interface Session {
  id: string
  profile: Profile
  store: BoardStore
  p2p: P2P
  files: FileService
  sources: LocalSources
  mirror: Mirror
  sync: FileSync
  transfers: TransferStore
  /** announces this person in the board's presence room (seen from other people's home screens) */
  presence: PresenceHandle
}

/** What this browser can serve is shared across boards (copy/paste between boards keeps working). */
const sources = new LocalSources()
const mirror = new Mirror()

function create(id: string): Session {
  const profile = getProfile()
  const store = new BoardStore(id, profile)
  const transfers = new TransferStore()
  const p2p = new P2P(
    store.provider,
    profile,
    sources,
    transfers,
    (key) => {
      for (const it of store.getSnapshot().all.values()) {
        // only items I share: a holder asked for someone else's file must answer notfound, not "relink"
        if (!('owner' in it) || it.owner !== profile.id) continue
        if (it.type === 'file' && it.key === key) return { name: it.name, kind: 'file' as const }
        if (it.type === 'folder' && it.mode === 'disk' && it.key === key) return { name: it.name, kind: 'dir' as const }
      }
      return undefined
    },
    mirror,
    id,
  )
  const files = new FileService(p2p, profile, transfers, mirror, id)
  const sync = new FileSync(store, p2p, mirror, sources, files, profile, transfers)
  store.onLoaded(() => {
    const all = [...store.getSnapshot().all.values()]
    // restore persisted handles (Chromium) for everything this person shares, without prompting
    for (const it of all) {
      if ((it.type === 'file' || (it.type === 'folder' && it.mode === 'disk')) && it.owner === profile.id && it.key) void sources.probe(it.key)
    }
    // an empty board is one this browser hasn't heard yet (a first visit, or cleared data), not one emptied
    // by edits: peers will fill it in, so keep every copy
    if (!all.length) return
    // the undo history died with the last visit: drop copies of files this board no longer has
    const hashes = new Set(all.flatMap((it) => (it.type === 'file' && it.hash ? [it.hash] : [])))
    const folders = new Set(all.flatMap((it) => (it.type === 'folder' && it.key ? [it.key] : [])))
    void sources.gcKept(id, new Set(all.flatMap((it) => (it.type === 'file' && it.owner === profile.id ? [it.key] : []))))
    void mirror.gc(id, (e) => hashes.has(e.hash) || e.aliases.some((a) => folders.has(a.slice(0, a.indexOf('/')))))
  })
  const presence = joinPresence(id, profile, () => store.name)
  store.meta.observe(() => presence.refresh())
  return { id, profile, store, p2p, files, sources, mirror, sync, transfers, presence }
}

interface Entry {
  session: Session
  refs: number
  timer?: ReturnType<typeof setTimeout>
}
const live = new Map<string, Entry>()

/**
 * Ref-counted so React StrictMode's mount/unmount/mount (and quick navigation) doesn't tear
 * the room down: y-webrtc releases a room name asynchronously, so we delay destruction.
 */
export function acquireSession(id: string): Session {
  let e = live.get(id)
  if (!e) {
    e = { session: create(id), refs: 0 }
    live.set(id, e)
  }
  if (e.timer) clearTimeout(e.timer)
  e.timer = undefined
  e.refs++
  return e.session
}

export function releaseSession(id: string) {
  const e = live.get(id)
  if (!e) return
  e.refs--
  if (e.refs > 0) return
  e.timer = setTimeout(() => {
    const cur = live.get(id)
    if (!cur || cur.refs > 0) return
    live.delete(id)
    cur.session.presence.release()
    cur.session.sync.destroy()
    cur.session.p2p.destroy()
    cur.session.store.destroy()
  }, 400)
}
