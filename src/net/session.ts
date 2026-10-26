import { BoardStore } from '../model/board'
import { getProfile, type Profile } from '../lib/storage'
import { FileService } from './fileService'
import { P2P } from './p2p'
import { LocalSources } from './sources'
import { TransferStore } from './transfers'

/** One board's worth of live objects: CRDT doc, mesh networking, file serving. */
export interface Session {
  id: string
  profile: Profile
  store: BoardStore
  p2p: P2P
  files: FileService
  sources: LocalSources
  transfers: TransferStore
}

/** What this browser can serve is shared across boards (copy/paste between boards keeps working). */
const sources = new LocalSources()

function create(id: string): Session {
  const profile = getProfile()
  const store = new BoardStore(id, profile)
  const transfers = new TransferStore()
  const p2p = new P2P(store.provider, profile, sources, transfers, (key) => {
    for (const it of store.getSnapshot().all.values()) {
      if (it.type === 'file' && it.key === key) return { name: it.name, kind: 'file' as const }
      if (it.type === 'folder' && it.mode === 'disk' && it.key === key) return { name: it.name, kind: 'dir' as const }
    }
    return undefined
  })
  const files = new FileService(p2p, profile, transfers)
  // restore persisted handles (Chromium) for everything this person shares, without prompting
  store.onLoaded(() => {
    for (const it of store.getSnapshot().all.values()) {
      if ((it.type === 'file' || (it.type === 'folder' && it.mode === 'disk')) && it.owner === profile.id && it.key) void sources.probe(it.key)
    }
  })
  return { id, profile, store, p2p, files, sources, transfers }
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
    cur.session.p2p.destroy()
    cur.session.store.destroy()
  }, 400)
}
