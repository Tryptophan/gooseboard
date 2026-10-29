import { createStore, get, set } from 'idb-keyval'
import { diag, diagSecrets, diagSection } from './diag'
import { toast } from './toast'

/**
 * Personal reminders: kept in this browser only (never in a board), and set off by whichever
 * Gooseboard tab is open, as a system notification when that's allowed and a toast when not.
 * There's no server to wake a closed app, so one that came due while nothing was open goes off,
 * marked missed, the next time something is.
 */

export type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly'

export interface Reminder {
  id: string
  text: string
  /** the first (or only) time it goes off, ms; repeats keep its time of day (and day of the month) */
  at: number
  repeat: Repeat
  /** weekly: which weekdays, 0 = Sunday */
  days?: number[]
  /** when it goes off next; null once a one-off has gone off */
  next: number | null
  /** a one-off that went off late, because nothing was open at its time */
  missed?: boolean
  /** the board it was made on, opened from its notification */
  board?: { id: string; name: string }
}

export const REPEATS: { id: Repeat; label: string }[] = [
  { id: 'none', label: 'Once' },
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
]

const KEY = 'gooseboard:reminders'
/** when the list was last saved: the newer of localStorage and IndexedDB wins at startup */
const REV = 'gooseboard:reminders-rev'
/**
 * A second copy in IndexedDB. Chrome writes localStorage to disk a while after it's set, so a
 * phone app closed by force soon after adding a reminder could lose it.
 */
const durable = createStore('gooseboard-reminders', 'reminders')
/** later than this is "missed" rather than just a slow timer */
const LATE = 2 * 60_000
/** how often to look even with nothing due soon: sleep and clock changes don't move timers */
const POLL = 30_000

const sorted = (l: Reminder[]) => [...l].sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity) || b.at - a.at)

let list: Reminder[] = sorted(load())
const listeners = new Set<() => void>()

function load(): Reminder[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function save(next: Reminder[]) {
  list = sorted(next)
  const rev = Date.now()
  void set('list', { rev, list: next }, durable).catch(() => {})
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
    localStorage.setItem(REV, String(rev))
  } catch {
    /* storage unavailable or full: they last for this session */
  }
  emit()
}

function emit() {
  listeners.forEach((l) => l())
  schedule()
}

export const subscribeReminders = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
/** soonest first; ones that are done last */
export const getReminders = () => list

/** Does `r` go off on this day (judged by its date, local time)? */
function onDay(r: Pick<Reminder, 'at' | 'repeat' | 'days'>, d: Date): boolean {
  const dow = d.getDay()
  switch (r.repeat) {
    case 'daily':
      return true
    case 'weekdays':
      return dow > 0 && dow < 6
    case 'weekly':
      return (r.days?.length ? r.days : [new Date(r.at).getDay()]).includes(dow)
    case 'monthly': {
      // the 31st goes off on the last day of shorter months
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      return d.getDate() === Math.min(new Date(r.at).getDate(), last)
    }
    default:
      return false
  }
}

/** The first time `r` goes off after `after`, or null if it never does again. */
export function nextTime(r: Pick<Reminder, 'at' | 'repeat' | 'days'>, after: number): number | null {
  if (r.at > after) {
    // a repeat whose first day doesn't match its days (weekly on other days) starts at the next match
    if (r.repeat === 'none' || onDay(r, new Date(r.at))) return r.at
  }
  if (r.repeat === 'none') return null
  const a = new Date(r.at)
  const from = new Date(Math.max(after, r.at))
  // built from the date and time of day each step, so daylight saving never shifts it
  for (let i = 0; i <= 400; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, a.getHours(), a.getMinutes())
    if (d.getTime() > after && onDay(r, d)) return d.getTime()
  }
  return null
}

export function saveReminder(r: Omit<Reminder, 'id' | 'next'> & { id?: string }) {
  // saving one re-arms it, so it's no longer missed
  const full: Reminder = { ...r, id: r.id ?? crypto.randomUUID(), next: nextTime(r, Date.now()), missed: undefined }
  const rest = load().filter((x) => x.id !== full.id)
  save([...rest, full])
  diag('reminder', r.id ? 'edited' : 'added', { repeat: r.repeat, inMs: full.next && full.next - Date.now() })
}

export function deleteReminder(id: string) {
  save(load().filter((x) => x.id !== id))
  diag('reminder', 'deleted')
}

// ---- notifications ----

export type NotifyState = 'granted' | 'denied' | 'default' | 'unsupported'
export const notifyState = (): NotifyState => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)

/** Asks for notifications if they haven't been asked about yet (call from a click). */
export async function askToNotify(): Promise<NotifyState> {
  if (notifyState() === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      /* older Safari only takes a callback; it asks next time */
    }
    diag('reminder', 'notification permission', notifyState())
    emit()
  }
  return notifyState()
}

const at = (t: number) => {
  const d = new Date(t)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return new Date().toDateString() === d.toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`
}
export const formatWhen = at

const boardHash = (r: Reminder) => (r.board ? `#/board/${r.board.id}` : '#/')
function openFor(r: Reminder) {
  window.focus()
  if (location.hash !== boardHash(r)) location.hash = boardHash(r)
}

async function notify(r: Reminder, due: number, missed: boolean) {
  const body = [missed && `Missed, at ${at(due)}`, r.board?.name || (r.board && 'Untitled board')].filter(Boolean).join(' · ')
  diag('reminder', missed ? 'went off late' : 'went off', { lateMs: Date.now() - due, via: notifyState() })
  if (notifyState() === 'granted') {
    const opts: NotificationOptions = { body: body || undefined, icon: `${import.meta.env.BASE_URL}icon-192.png`, tag: r.id, data: { url: new URL(boardHash(r), location.href).href } }
    try {
      // through the service worker where there is one: Android has no page-made notifications
      const reg = await navigator.serviceWorker?.getRegistration()
      if (reg) await reg.showNotification(r.text, opts)
      else new Notification(r.text, opts).onclick = () => openFor(r)
      // one found missed on opening the app is shown here too: it's what you're looking at
      if (!missed) return
    } catch (e) {
      diag('reminder', 'notification failed', e)
    }
  }
  const here = location.hash === boardHash(r) || !r.board
  toast(`${missed ? 'Missed reminder' : 'Reminder'}: ${r.text}${missed ? ` (${at(due)})` : ''}`, here ? undefined : { label: 'Open board', run: () => openFor(r) }, 20_000)
}

/** Sets off whatever is due, once across every open tab, and moves each to its next time. */
async function check() {
  const run = () => {
    const now = Date.now()
    const fresh = load()
    const due: [Reminder, number][] = []
    for (const r of fresh) {
      if (r.next === null || r.next > now) continue
      const t = r.next
      due.push([r, t])
      // a repeat missed many times goes off once, then waits for its next time from now
      r.next = nextTime(r, now)
      if (r.next === null && now - t > LATE) r.missed = true
    }
    if (due.length) save(fresh)
    return due
  }
  const due = navigator.locks ? await navigator.locks.request('gooseboard:reminders', run) : run()
  for (const [r, t] of due) void notify(r, t, Date.now() - t > LATE)
}

let timer: ReturnType<typeof setTimeout> | undefined
let started = false
function schedule() {
  if (!started) return
  clearTimeout(timer)
  const soonest = Math.min(...list.map((r) => r.next ?? Infinity))
  timer = setTimeout(() => void check().finally(schedule), Math.max(0, Math.min(POLL, soonest - Date.now())))
}

/** Call once at startup, on every page. */
export function startReminders() {
  if (started) return
  started = true
  // another tab added, edited, or set one off
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      list = sorted(load())
      emit()
    }
  })
  // a tab coming back from the background (or the computer from sleep) looks straight away
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void check().finally(schedule))
  // a notification clicked while this tab was the one open: the service worker asks it to go there
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.t !== 'gooseboard-open' || typeof e.data.url !== 'string') return
    const u = new URL(e.data.url)
    if (u.origin === location.origin && location.hash !== u.hash) location.hash = u.hash
  })
  diagSection('reminders', () => ({ count: list.length, active: list.filter((r) => r.next !== null).length, notifications: notifyState() }))
  diagSecrets(() => list.flatMap((r) => [r.text, r.board?.id, r.board?.name]))
  void restore()
    .then(check)
    .finally(schedule)
}

/** Takes the IndexedDB copy if it's newer than localStorage's (which lost its last writes). */
async function restore() {
  const d = await get<{ rev: number; list: Reminder[] }>('list', durable).catch(() => undefined)
  let rev = 0
  try {
    rev = Number(localStorage.getItem(REV) ?? 0)
  } catch {
    /* unavailable: IndexedDB's copy is all there is */
  }
  if (!d || !Array.isArray(d.list) || d.rev <= rev) return
  diag('reminder', 'restored from IndexedDB', { count: d.list.length })
  try {
    localStorage.setItem(KEY, JSON.stringify(d.list))
    localStorage.setItem(REV, String(d.rev))
  } catch {
    /* kept in memory for this session */
  }
  list = sorted(d.list)
  emit()
}
