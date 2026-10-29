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

function read(m: Y.Map<any>): ChatMessage {
  return { id: m.get('id'), at: m.get('at') ?? 0, from: m.get('from') ?? { id: '', name: 'Someone', color: '#9aa5b1' }, text: String(m.get('text') ?? '') }
}

/** A board's chat, read once per change, for useSyncExternalStore. */
class ChatLog {
  private list: ChatMessage[] = []
  private listeners = new Set<() => void>()
  private seen: number
  private unreadCount = 0

  constructor(readonly store: BoardStore) {
    this.seen = loadChatSeen(store.id)
    this.read()
    store.chat.observeDeep(() => {
      this.read()
      this.listeners.forEach((l) => l())
    })
  }

  private read() {
    this.list = this.store.chat.toArray().map(read)
    this.count()
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
  /** messages from others since this browser last looked */
  unread = () => this.unreadCount

  /** Everything so far has been seen. */
  markSeen() {
    const at = Math.max(Date.now(), ...this.list.slice(-1).map((m) => m.at))
    if (!this.unreadCount && at - this.seen < 60_000) return
    this.seen = at
    saveChatSeen(this.store.id, at)
    this.count()
    this.listeners.forEach((l) => l())
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
