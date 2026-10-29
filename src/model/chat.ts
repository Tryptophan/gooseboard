import * as Y from 'yjs'
import { newItemId } from '../lib/ids'
import { loadChatSeen, saveChatSeen } from '../lib/storage'
import type { BoardStore } from './board'

/** The board's chat: a Y.Array of message maps under `chat`, kept with the board like everything else. */
export interface ChatMessage {
  id: string
  /** ms since the epoch, by the sender's clock */
  at: number
  /** who wrote it, as they were named then */
  from: { id: string; name: string; color: string }
  text: string
}

/**
 * Someone who has opened the board, from the doc's `members` map (keyed by profile id). How far
 * they've got through the chat is kept as steps, `[count, at]`: by `at` they had received (or read)
 * the first `count` messages. Steps rather than a mark per message keep it small; a message's time
 * is that of the first step past it.
 */
export interface Member {
  id: string
  name: string
  color: string
  /** when they first opened the board */
  joined: number
  delivered: [number, number][]
  read: [number, number][]
}

export type Receipt = 'pending' | 'delivered' | 'read'

export interface Recipient {
  member: Member
  /** when they received it, and when they read it, if they have */
  delivered?: number
  read?: number
}

/** steps kept per person; older messages then show their status without a time */
const STEPS = 300

function read(m: Y.Map<any>): ChatMessage {
  return { id: m.get('id'), at: m.get('at') ?? 0, from: m.get('from') ?? { id: '', name: 'Someone', color: '#9aa5b1' }, text: String(m.get('text') ?? '') }
}

const steps = (a: unknown): [number, number][] => (a instanceof Y.Array ? a.toArray() : [])

function readMember(id: string, m: Y.Map<any>): Member {
  return { id, name: m.get('name') ?? 'Someone', color: m.get('color') ?? '#9aa5b1', joined: m.get('joined') ?? 0, delivered: steps(m.get('delivered')), read: steps(m.get('read')) }
}

/** When the steps first got past message `i` (Infinity if they haven't; for one older than the steps kept, the oldest kept). */
function reached(s: [number, number][], i: number): number {
  return s.find(([count]) => count > i)?.[1] ?? Infinity
}

/** A board's chat, read once per change, for useSyncExternalStore. */
class ChatLog {
  private list: ChatMessage[] = []
  private people: Member[] = []
  private listeners = new Set<() => void>()
  private seen: number
  private unreadCount = 0
  private pending: ReturnType<typeof setTimeout> | undefined

  constructor(readonly store: BoardStore) {
    this.seen = loadChatSeen(store.id)
    this.read()
    this.readMembers()
    store.chat.observeDeep(() => {
      this.read()
      this.emit()
      // what's arrived is delivered; a burst (the history, on first sync) is marked once
      clearTimeout(this.pending)
      this.pending = setTimeout(() => this.mark('delivered'), 300)
    })
    store.members.observeDeep(() => {
      this.readMembers()
      this.emit()
    })
    // marked once what's on disk is in, or it would count an empty chat first
    store.onLoaded(() => this.mark('delivered'))
  }

  private emit() {
    this.listeners.forEach((l) => l())
  }
  private read() {
    this.list = this.store.chat.toArray().map(read)
    this.count()
  }
  private readMembers() {
    this.people = [...this.store.members.entries()].map(([id, m]) => readMember(id, m)).sort((a, b) => a.joined - b.joined)
  }
  private count() {
    const me = this.store.profile.id
    this.unreadCount = this.list.filter((m) => m.at > this.seen && m.from.id !== me).length
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  get = () => this.list
  members = () => this.people
  /** messages from others since this browser last looked */
  unread = () => this.unreadCount

  /** Everything so far has been seen (the chat is open): on this browser's unread count, and, with the page in front, as read for everyone else. */
  markSeen() {
    if (document.visibilityState === 'visible') this.mark('read')
    const at = Math.max(Date.now(), ...this.list.slice(-1).map((m) => m.at))
    if (!this.unreadCount && at - this.seen < 60_000) return
    this.seen = at
    saveChatSeen(this.store.id, at)
    this.count()
    this.emit()
  }

  /** Records that this person has received (or read, and so received) every message so far. */
  private mark(what: 'delivered' | 'read') {
    if (!this.store.loaded) return
    const { profile, members, doc, chat } = this.store
    const n = chat.length
    doc.transact(() => {
      let me = members.get(profile.id)
      if (!me) {
        me = new Y.Map<any>()
        members.set(profile.id, me)
        me.set('joined', Date.now())
      }
      // their name and colour as they are now
      if (me.get('name') !== profile.name) me.set('name', profile.name)
      if (me.get('color') !== profile.color) me.set('color', profile.color)
      for (const key of what === 'read' ? (['delivered', 'read'] as const) : (['delivered'] as const)) {
        let s = me.get(key) as Y.Array<[number, number]> | undefined
        if (!(s instanceof Y.Array)) me.set(key, (s = new Y.Array()))
        const last = s.length ? s.get(s.length - 1)[0] : 0
        if (n <= last) continue
        s.push([[n, Date.now()]])
        if (s.length > STEPS) s.delete(0, s.length - STEPS)
      }
    })
  }

  /** Everyone but the sender, with when they received and read message `i`. */
  recipients(i: number): Recipient[] {
    const from = this.list[i]?.from.id
    return this.people
      .filter((p) => p.id !== from)
      .map((member) => {
        const d = reached(member.delivered, i)
        const r = reached(member.read, i)
        return { member, ...(d !== Infinity && { delivered: d }), ...(r !== Infinity && { read: r }) }
      })
  }

  /** The tick on one's own message: has anyone received it yet, or read it? */
  receipt(i: number): Receipt {
    const all = this.recipients(i)
    if (all.some((r) => r.read !== undefined)) return 'read'
    if (all.some((r) => r.delivered !== undefined)) return 'delivered'
    return 'pending'
  }

  /** Sends one of this person's messages. */
  send(text: string) {
    const { profile, chat } = this.store
    const m = new Y.Map<any>()
    this.store.doc.transact(() => {
      chat.push([m])
      m.set('id', newItemId())
      m.set('at', Date.now())
      m.set('from', { id: profile.id, name: profile.name, color: profile.color })
      m.set('text', text)
    })
  }
}

const logs = new WeakMap<BoardStore, ChatLog>()
export function chatLog(store: BoardStore): ChatLog {
  let l = logs.get(store)
  if (!l) logs.set(store, (l = new ChatLog(store)))
  return l
}
