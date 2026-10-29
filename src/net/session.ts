import { BoardStore } from '../model/board'
import { voiceFiles } from '../model/chat'
import { diagSecrets, diagSection, tag } from '../lib/diag'
import { getBoards, getProfile, type Profile } from '../lib/storage'
import { FileService } from './fileService'
import { Mirror } from './mirror'
import { P2P } from './p2p'
import { PartialCache } from './partial'
import { joinPresence, type PresenceHandle } from './presence'
import { LocalSources } from './sources'
import { gcPreviews } from './previewCache'
import { gcThumbs } from './thumbCache'
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
  partial: PartialCache
  sync: FileSync
  transfers: TransferStore
  /** announces this person in the board's presence room (seen from other people's home screens) */
  presence: PresenceHandle
}

/** What this browser can serve is shared across boards (copy/paste between boards keeps working). */
const sources = new LocalSources()
const mirror = new Mirror()
const partial = new PartialCache()

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
    partial,
  )
  const files = new FileService(p2p, profile, transfers, mirror, id, partial)
  const sync = new FileSync(store, p2p, mirror, sources, files, profile, transfers, partial)
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
    const hashes = new Set(all.flatMap((it) => (it.type === 'file' && it.hash ? [it.hash] : [])).concat(voiceFiles(store).map((v) => v.hash!)))
    const folders = new Set(all.flatMap((it) => (it.type === 'folder' && it.key ? [it.key] : [])))
    void sources.gcKept(id, new Set(all.flatMap((it) => (it.type === 'file' && it.owner === profile.id ? [it.key] : []))))
    void gcThumbs(id, new Set(all.flatMap((it) => ((it.type === 'file' || it.type === 'folder') && it.owner === profile.id && it.key ? [it.key] : []))))
    void gcPreviews(id, new Set(all.flatMap((it) => (it.type === 'file' ? [`preview\0${it.owner}\0${it.key}`] : []))))
    void mirror.gc(id, (e) => hashes.has(e.hash) || e.aliases.some((a) => folders.has(a.slice(0, a.indexOf('/')))))
  })
  const presence = joinPresence(id, profile, () => store.name)
  store.meta.observe(() => presence.refresh())
  return { id, profile, store, p2p, files, sources, mirror, partial, sync, transfers, presence }
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

diagSection('boards', () => ({
  saved: getBoards().length,
  open: [...live.values()].map(({ session: s, refs }) => {
    const items = [...s.store.getSnapshot().all.values()]
    const types: Record<string, number> = {}
    for (const it of items) types[it.type] = (types[it.type] ?? 0) + 1
    return {
      board: tag(s.id),
      refs,
      items: types,
      people: s.store.awareness.getStates().size,
      p2p: s.p2p.diagInfo(),
      mirror: s.mirror.stats(),
      partial: s.partial.stats(),
    }
  }),
}))

/** ids, names, links, and the like never leave in a diagnostics dump */
diagSecrets(function* () {
  const me = getProfile()
  yield me.id
  yield me.name
  for (const b of getBoards()) yield* [b.id, b.name, b.pendingName]
  for (const { session: s } of live.values()) {
    yield s.id
    yield s.store.name
    for (const it of s.store.getSnapshot().all.values()) {
      yield it.id
      for (const k of ['name', 'url', 'key', 'hash', 'owner', 'title'] as const) {
        const v = (it as unknown as Record<string, unknown>)[k]
        if (typeof v === 'string') yield v
      }
    }
    for (const st of s.store.awareness.getStates().values()) {
      const u = (st as { user?: { id?: string; name?: string } }).user
      if (u) yield* [u.id, u.name]
    }
  }
})

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
