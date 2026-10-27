import { newUserId } from './ids'

export interface Profile {
  id: string
  name: string
  color: string
}

export interface BoardEntry {
  id: string
  name: string
  createdAt: number
  lastOpened: number
  /** Set by a rename from the home screen; written into the board doc on next open. */
  pendingName?: string
}

export type ThemePref = 'system' | 'light' | 'dark'

const K = {
  profile: 'gooseboard:profile',
  boards: 'gooseboard:boards',
  theme: 'gooseboard:theme',
  camera: (id: string) => `gooseboard:camera:${id}`,
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable or full: the app still works for this session */
  }
}

export const USER_COLORS = ['#e5484d', '#f76b15', '#d9a400', '#30a46c', '#0fa5a5', '#3e63dd', '#8e4ec6', '#d6409f']
const ADJ = ['Brave', 'Sneaky', 'Fluffy', 'Honking', 'Grumpy', 'Plucky', 'Mighty', 'Sleepy', 'Cheeky', 'Noble']
const NOUN = ['Goose', 'Gander', 'Gosling', 'Honker', 'Waddler']

function randomProfile(): Profile {
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]
  return { id: newUserId(), name: `${pick(ADJ)} ${pick(NOUN)}`, color: pick(USER_COLORS) }
}

let cachedProfile: Profile | null = null

export function getProfile(): Profile {
  if (cachedProfile) return cachedProfile
  let p = read<Profile>(K.profile)
  if (!p || !p.id) {
    p = randomProfile()
    write(K.profile, p)
  }
  cachedProfile = p
  return p
}

/** Mutates the shared profile object in place so long-lived holders (sessions, P2P) see the change. */
export function saveProfile(patch: Partial<Pick<Profile, 'name' | 'color'>>): Profile {
  const p = Object.assign(getProfile(), patch)
  write(K.profile, p)
  return p
}

export function getBoards(): BoardEntry[] {
  return (read<BoardEntry[]>(K.boards) ?? []).sort((a, b) => b.lastOpened - a.lastOpened)
}

function saveBoards(list: BoardEntry[]) {
  write(K.boards, list)
}

/** Records a board visit; creates the entry if it is new. */
export function touchBoard(id: string, name?: string): BoardEntry {
  const list = getBoards()
  let e = list.find((b) => b.id === id)
  if (!e) {
    e = { id, name: name ?? 'Untitled board', createdAt: Date.now(), lastOpened: Date.now() }
    list.push(e)
  } else {
    e.lastOpened = Date.now()
    if (name && (e.name === 'Untitled board' || !e.name)) e.name = name
  }
  saveBoards(list)
  return e
}

export function renameBoardLocal(id: string, name: string) {
  const list = getBoards()
  const e = list.find((b) => b.id === id)
  if (e) {
    e.name = name
    saveBoards(list)
  }
}

/** Renames from outside the board; the doc picks it up via takePendingName. */
export function renameBoardPending(id: string, name: string) {
  const list = getBoards()
  const e = list.find((b) => b.id === id)
  if (e) {
    e.name = name
    e.pendingName = name
    saveBoards(list)
  }
}

export function takePendingName(id: string): string | undefined {
  const list = getBoards()
  const e = list.find((b) => b.id === id)
  const name = e?.pendingName
  if (e && name !== undefined) {
    delete e.pendingName
    saveBoards(list)
  }
  return name
}

export function forgetBoard(id: string) {
  saveBoards(getBoards().filter((b) => b.id !== id))
  try {
    localStorage.removeItem(K.camera(id))
  } catch {
    /* ignore */
  }
}

export const getTheme = (): ThemePref => read<ThemePref>(K.theme) ?? 'system'
export const saveTheme = (t: ThemePref) => write(K.theme, t)

export const loadCamera = (id: string) => read<{ x: number; y: number; z: number }>(K.camera(id))
export const saveCamera = (id: string, c: { x: number; y: number; z: number }) => write(K.camera(id), c)
