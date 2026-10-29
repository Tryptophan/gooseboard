import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'
import { IndexeddbPersistence } from 'y-indexeddb'
import { ICE_SERVERS, ROOM_PREFIX } from '../config'
import { newItemId } from '../lib/ids'
import type { Profile } from '../lib/storage'
import { installSignaling, SIGNAL_URLS } from '../net/signal'
import { DEFAULT_SIZE, type Item, type Presence } from './types'
import { fragmentToJSON, jsonToFragment } from './noteSchema'

/** Transaction origin for everything this client does (tracked by the undo manager). */
export const LOCAL = 'gooseboard-local'

export interface Snapshot {
  /** every item, including ones inside folders */
  all: Map<string, Item>
  /** items drawn on the board, back to front */
  surface: Item[]
  /** folder id -> contained items (by z) */
  children: Map<string, Item[]>
  version: number
}

export interface ExportedItem {
  props: Record<string, any>
  content?: any
}

type Listener = () => void

function readItem(id: string, m: Y.Map<any>): Item {
  const o: Record<string, any> = { id }
  m.forEach((v, k) => {
    if (!(v instanceof Y.AbstractType)) o[k] = v
  })
  if (o.parent === undefined) o.parent = null
  if (typeof o.rot !== 'number') o.rot = 0
  return o as Item
}

export class BoardStore {
  readonly doc = new Y.Doc()
  readonly items = this.doc.getMap<Y.Map<any>>('items')
  readonly meta = this.doc.getMap<any>('meta')
  /** chat messages, oldest first (model/chat) */
  readonly chat = this.doc.getArray<Y.Map<any>>('chat')
  /** everyone who has opened the board, and how far through the chat each has received and read (model/chat) */
  readonly members = this.doc.getMap<Y.Map<any>>('members')
  readonly provider: WebrtcProvider
  readonly persistence: IndexeddbPersistence
  readonly undo: Y.UndoManager
  readonly awareness
  loaded = false

  private snap: Snapshot = { all: new Map(), surface: [], children: new Map(), version: 0 }
  private listeners = new Set<Listener>()
  private loadListeners = new Set<Listener>()

  constructor(
    readonly id: string,
    readonly profile: Profile,
  ) {
    this.persistence = new IndexeddbPersistence(ROOM_PREFIX + id, this.doc)
    installSignaling()
    this.provider = new WebrtcProvider(ROOM_PREFIX + id, this.doc, {
      signaling: SIGNAL_URLS,
      // signaling crosses public relays: encrypt it with the board id, which only link holders know
      password: id,
      peerOpts: { config: { iceServers: ICE_SERVERS } },
    })
    this.awareness = this.provider.awareness
    this.undo = new Y.UndoManager([this.items], { trackedOrigins: new Set([LOCAL]), captureTimeout: 500 })

    this.items.observeDeep((events) => this.onItemsChanged(events))
    this.rebuild(null)

    this.persistence.whenSynced.then(() => {
      this.loaded = true
      this.rebuild(null)
      this.loadListeners.forEach((l) => l())
    })

    this.awareness.setLocalState({
      user: { id: profile.id, name: profile.name, color: profile.color, accessory: profile.accessory },
      cursor: null,
      view: null,
      draft: null,
    } satisfies Presence)
  }

  // ---- subscription (useSyncExternalStore) ----
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getSnapshot = () => this.snap
  onLoaded(l: Listener) {
    if (this.loaded) l()
    else this.loadListeners.add(l)
  }

  // ---- derived state ----
  private onItemsChanged(events: Y.YEvent<any>[]) {
    const dirty = new Set<string>()
    for (const ev of events) {
      if (ev.path.length === 0) {
        ev.changes.keys.forEach((_c, key) => dirty.add(key))
      } else {
        // path[1] === 'content' is note text: rendered by the note itself, no board change
        if (ev.path.length >= 2 && ev.path[1] === 'content') continue
        dirty.add(String(ev.path[0]))
      }
    }
    if (dirty.size) this.rebuild(dirty)
  }

  private rebuild(dirty: Set<string> | null) {
    const all = new Map<string, Item>()
    this.items.forEach((m, id) => {
      const prev = this.snap.all.get(id)
      all.set(id, !dirty || dirty.has(id) || !prev ? readItem(id, m) : prev)
    })
    const surface: Item[] = []
    const children = new Map<string, Item[]>()
    for (const it of all.values()) {
      if (it.parent && all.has(it.parent)) {
        const list = children.get(it.parent) ?? []
        list.push(it)
        children.set(it.parent, list)
      } else surface.push(it)
    }
    surface.sort((a, b) => a.z - b.z)
    children.forEach((l) => l.sort((a, b) => a.z - b.z))
    this.snap = { all, surface, children, version: this.snap.version + 1 }
    this.listeners.forEach((l) => l())
  }

  // ---- mutations ----
  transact<T>(fn: () => T): T {
    return this.doc.transact(fn, LOCAL) as T
  }

  private maxZ(): number {
    let z = 0
    this.snap.all.forEach((i) => (z = Math.max(z, i.z)))
    return z
  }
  private minZ(): number {
    let z = 0
    this.snap.all.forEach((i) => (z = Math.min(z, i.z)))
    return z
  }

  /** Adds an item. Returns its id. */
  add(init: Record<string, any> & { type: Item['type'] }, id = newItemId()): string {
    this.transact(() => {
      const size = DEFAULT_SIZE[init.type]
      const m = new Y.Map<any>()
      const props = { x: 0, y: 0, w: size.w, h: size.h, rot: 0, parent: null, ...init, z: this.maxZ() + 1 }
      for (const [k, v] of Object.entries(props)) if (v !== undefined) m.set(k, v)
      this.items.set(id, m)
      if (init.type === 'note') m.set('content', new Y.XmlFragment())
    })
    return id
  }

  update(id: string, patch: Record<string, any>) {
    const m = this.items.get(id)
    if (!m) return
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) if (m.get(k) !== v) m.set(k, v)
    })
  }

  /** Background bookkeeping (e.g. content hashes): not an undo step. */
  updateSilent(id: string, patch: Record<string, any>) {
    const m = this.items.get(id)
    if (!m) return
    this.doc.transact(() => {
      for (const [k, v] of Object.entries(patch)) if (m.get(k) !== v) m.set(k, v)
    }, 'gooseboard-system')
  }

  updateMany(patches: Record<string, Record<string, any>>) {
    this.transact(() => {
      for (const [id, patch] of Object.entries(patches)) {
        const m = this.items.get(id)
        if (!m) continue
        for (const [k, v] of Object.entries(patch)) if (m.get(k) !== v) m.set(k, v)
      }
    })
  }

  /** Deletes items and everything inside deleted folders. */
  remove(ids: Iterable<string>) {
    const doomed = new Set<string>()
    const visit = (id: string) => {
      if (doomed.has(id)) return
      doomed.add(id)
      this.snap.children.get(id)?.forEach((c) => visit(c.id))
    }
    for (const id of ids) visit(id)
    this.transact(() => doomed.forEach((id) => this.items.delete(id)))
  }

  /** Moves items into `parent`; drawing strokes only live on the board, so they never go into a folder. Returns the ids moved. */
  reparent(ids: string[], parent: string | null): string[] {
    const patches: Record<string, Record<string, any>> = {}
    for (const id of ids) {
      if (id === parent || (parent && this.isDescendant(parent, id))) continue
      if (parent && this.snap.all.get(id)?.type === 'stroke') continue
      patches[id] = { parent }
    }
    this.updateMany(patches)
    return Object.keys(patches)
  }

  /** true if `id` sits (transitively) inside `ancestor` */
  isDescendant(id: string, ancestor: string): boolean {
    let cur = this.snap.all.get(id)
    const seen = new Set<string>()
    while (cur?.parent && !seen.has(cur.id)) {
      if (cur.parent === ancestor) return true
      seen.add(cur.id)
      cur = this.snap.all.get(cur.parent)
    }
    return false
  }

  bringToFront(ids: string[]) {
    let z = this.maxZ()
    const sorted = ids.map((i) => this.snap.all.get(i)).filter(Boolean).sort((a, b) => a!.z - b!.z)
    this.updateMany(Object.fromEntries(sorted.map((it) => [it!.id, { z: ++z }])))
  }

  sendToBack(ids: string[]) {
    let z = this.minZ()
    const sorted = ids.map((i) => this.snap.all.get(i)).filter(Boolean).sort((a, b) => b!.z - a!.z)
    this.updateMany(Object.fromEntries(sorted.map((it) => [it!.id, { z: --z }])))
  }

  noteFragment(id: string): Y.XmlFragment | null {
    const f = this.items.get(id)?.get('content')
    return f instanceof Y.XmlFragment ? f : null
  }

  get name(): string {
    return (this.meta.get('name') as string | undefined) ?? ''
  }
  setName(name: string) {
    this.transact(() => this.meta.set('name', name))
  }

  // ---- export / import (clipboard + duplicate) ----
  exportItems(ids: string[]): ExportedItem[] {
    const out: ExportedItem[] = []
    const seen = new Set<string>()
    const visit = (id: string) => {
      const it = this.snap.all.get(id)
      if (!it || seen.has(id)) return
      seen.add(id)
      const e: ExportedItem = { props: { ...it } }
      if (it.type === 'note') {
        const f = this.noteFragment(id)
        if (f) e.content = fragmentToJSON(f)
      }
      out.push(e)
      this.snap.children.get(id)?.forEach((c) => visit(c.id))
    }
    ids.forEach(visit)
    return out
  }

  /** Re-creates exported items with fresh ids; roots land in `parent`, shifted by (dx, dy). */
  importItems(list: ExportedItem[], dx: number, dy: number, parent: string | null = null): string[] {
    const idMap = new Map<string, string>()
    list.forEach((e) => idMap.set(e.props.id, newItemId()))
    const roots: string[] = []
    this.transact(() => {
      // keep relative stacking: insert in z order
      const ordered = [...list].sort((a, b) => (a.props.z ?? 0) - (b.props.z ?? 0))
      for (const e of ordered) {
        const { id: oldId, z: _z, parent: oldParent, ...rest } = e.props
        const isRoot = !oldParent || !idMap.has(oldParent)
        const id = idMap.get(oldId)!
        const init = {
          ...rest,
          x: isRoot ? (rest.x ?? 0) + dx : rest.x,
          y: isRoot ? (rest.y ?? 0) + dy : rest.y,
          parent: isRoot ? parent : idMap.get(oldParent)!,
        }
        this.add(init as any, id)
        if (isRoot) roots.push(id)
        if (e.content) {
          const f = this.noteFragment(id)
          if (f) jsonToFragment(e.content, f)
        }
      }
    })
    return roots
  }

  duplicate(ids: string[], dx = 24, dy = 24): string[] {
    const roots = ids.filter((id) => {
      const it = this.snap.all.get(id)
      return it && !ids.some((o) => o !== id && this.isDescendant(id, o))
    })
    const parent = roots.length ? (this.snap.all.get(roots[0])?.parent ?? null) : null
    return this.importItems(this.exportItems(roots), dx, dy, parent)
  }

  // ---- presence ----
  setPresence(patch: Partial<Presence>) {
    const cur = (this.awareness.getLocalState() ?? {}) as Presence
    this.awareness.setLocalState({ ...cur, ...patch })
  }

  setProfile(p: Profile) {
    this.setPresence({ user: { id: p.id, name: p.name, color: p.color, accessory: p.accessory } })
  }

  destroy() {
    this.undo.destroy()
    this.provider.destroy()
    this.persistence.destroy()
    this.doc.destroy()
    this.listeners.clear()
  }
}
