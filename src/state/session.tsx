import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Session } from '../net/session'
import type { Snapshot } from '../model/board'
import type { PresenceUser, Presence } from '../model/types'

const SessionCtx = createContext<Session | null>(null)

export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  return (
    <SessionCtx.Provider value={session}>
      <PeersProvider session={session}>{children}</PeersProvider>
    </SessionCtx.Provider>
  )
}

export function useSession(): Session {
  const s = useContext(SessionCtx)
  if (!s) throw new Error('SessionProvider missing')
  return s
}

export function useSnapshot(): Snapshot {
  const { store } = useSession()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export function useTransfers() {
  const { transfers } = useSession()
  return useSyncExternalStore(transfers.subscribe, transfers.getSnapshot)
}

/** Re-renders when mesh links / pending relinks change. */
export function useP2P() {
  const { p2p } = useSession()
  useSyncExternalStore(p2p.subscribe, p2p.getVersion)
  return p2p
}

export function usePendingRelinks() {
  const { p2p } = useSession()
  return useSyncExternalStore(p2p.subscribe, p2p.getPending)
}

/** Re-renders when background file sync state (progress, holders, cache) changes. */
export function useFileSync() {
  const { sync } = useSession()
  useSyncExternalStore(sync.subscribe, sync.getVersion)
  return sync
}

export function useSourcesVersion() {
  const { sources } = useSession()
  return useSyncExternalStore(sources.subscribe, sources.getVersion)
}

export interface Peer extends PresenceUser {
  clientId: number
  isSelf: boolean
}

interface PeersValue {
  peers: Peer[]
  /** profile ids currently in the room (including me) */
  online: Set<string>
}

const PeersCtx = createContext<PeersValue>({ peers: [], online: new Set() })
export const usePeers = () => useContext(PeersCtx)

function PeersProvider({ session, children }: { session: Session; children: ReactNode }) {
  const { store } = session
  const [peers, setPeers] = useState<Peer[]>([])

  useEffect(() => {
    const aw = store.awareness
    let last = ''
    const read = () => {
      const list: Peer[] = []
      aw.getStates().forEach((st, clientId) => {
        const u = (st as Presence).user
        if (u) list.push({ ...u, clientId, isSelf: clientId === aw.clientID })
      })
      list.sort((a, b) => (a.isSelf ? -1 : b.isSelf ? 1 : a.clientId - b.clientId))
      const key = JSON.stringify(list)
      if (key !== last) {
        last = key
        setPeers(list)
      }
    }
    read()
    aw.on('change', read)
    return () => aw.off('change', read)
  }, [store])

  const value = useMemo(() => ({ peers, online: new Set(peers.map((p) => p.id)) }), [peers])
  return <PeersCtx.Provider value={value}>{children}</PeersCtx.Provider>
}
