import { createStore, del, get, set } from 'idb-keyval'
import { mimeOf } from '../lib/files'

export interface DirEntry {
  name: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  mime: string
}

export interface DirSource {
  list(path: string): Promise<DirEntry[]>
  getFile(path: string): Promise<File>
}

const handleStore = createStore('gooseboard-handles', 'handles')

const segs = (path: string) => {
  const parts = path.split('/').filter(Boolean)
  if (parts.some((p) => p === '.' || p === '..')) throw new Error('bad path')
  return parts
}

const sortEntries = (e: DirEntry[]) =>
  e.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'dir' ? -1 : 1))

/** A real directory via the File System Access API (Chromium). */
export class HandleDir implements DirSource {
  constructor(readonly root: any) {}

  private async dirAt(parts: string[]) {
    let d = this.root
    for (const p of parts) d = await d.getDirectoryHandle(p)
    return d
  }

  async list(path: string): Promise<DirEntry[]> {
    const d = await this.dirAt(segs(path))
    const out: DirEntry[] = []
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'directory') out.push({ name, kind: 'dir', size: 0, mtime: 0, mime: '' })
      else {
        const f: File = await h.getFile()
        out.push({ name, kind: 'file', size: f.size, mtime: f.lastModified, mime: mimeOf(name, f.type) })
      }
    }
    return sortEntries(out)
  }

  async getFile(path: string): Promise<File> {
    const parts = segs(path)
    const name = parts.pop()
    if (!name) throw new Error('no file')
    const d = await this.dirAt(parts)
    return (await d.getFileHandle(name)).getFile()
  }
}

/** A directory snapshot built from <input webkitdirectory> or a drag-and-drop entry walk (Firefox). */
export class FileListDir implements DirSource {
  private files = new Map<string, File>()
  private dirs = new Map<string, Map<string, DirEntry>>()

  constructor(entries: { path: string; file: File }[]) {
    this.dirs.set('', new Map())
    for (const { path, file } of entries) {
      const parts = path.split('/').filter(Boolean)
      if (!parts.length) continue
      this.files.set(parts.join('/'), file)
      for (let i = 0; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/')
        const full = parts.slice(0, i + 1).join('/')
        if (!this.dirs.has(parent)) this.dirs.set(parent, new Map())
        const isFile = i === parts.length - 1
        if (!isFile && !this.dirs.has(full)) this.dirs.set(full, new Map())
        this.dirs.get(parent)!.set(
          parts[i],
          isFile
            ? { name: parts[i], kind: 'file', size: file.size, mtime: file.lastModified, mime: mimeOf(parts[i], file.type) }
            : { name: parts[i], kind: 'dir', size: 0, mtime: 0, mime: '' },
        )
      }
    }
  }

  /** From an <input webkitdirectory> FileList: drop the leading root folder segment. */
  static fromInput(list: ArrayLike<File>): { name: string; source: FileListDir } {
    const arr = Array.from(list)
    const root = (arr[0] as any)?.webkitRelativePath?.split('/')[0] ?? 'folder'
    return {
      name: root,
      source: new FileListDir(arr.map((f) => ({ path: ((f as any).webkitRelativePath as string).split('/').slice(1).join('/'), file: f }))),
    }
  }

  async list(path: string): Promise<DirEntry[]> {
    const d = this.dirs.get(segs(path).join('/'))
    if (!d) throw new Error('not found')
    return sortEntries([...d.values()])
  }

  async getFile(path: string): Promise<File> {
    const f = this.files.get(segs(path).join('/'))
    if (!f) throw new Error('not found')
    return f
  }
}

/** Recursively reads a dropped directory entry (webkitGetAsEntry). */
export async function readEntryTree(entry: any): Promise<{ name: string; source: FileListDir }> {
  const out: { path: string; file: File }[] = []
  const readAll = async (dir: any): Promise<any[]> => {
    const reader = dir.createReader()
    const all: any[] = []
    for (;;) {
      const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) return all
      all.push(...batch)
    }
  }
  const walk = async (e: any, prefix: string): Promise<void> => {
    if (e.isFile) {
      const file: File = await new Promise((res, rej) => e.file(res, rej))
      out.push({ path: prefix + e.name, file })
    } else if (e.isDirectory) {
      for (const c of await readAll(e)) await walk(c, prefix + e.name + '/')
    }
  }
  for (const c of await readAll(entry)) await walk(c, '')
  return { name: entry.name, source: new FileListDir(out) }
}

type Listener = () => void

/**
 * What THIS browser can serve. Files are never uploaded: bytes are read from disk on demand.
 * Chromium persists handles in IndexedDB so sharing survives reloads; Firefox holds File
 * objects in memory only, so after a reload the owner is asked to relink when someone asks.
 */
export class LocalSources {
  private files = new Map<string, File>()
  private dirs = new Map<string, DirSource>()
  private version = 0
  private listeners = new Set<Listener>()

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getVersion = () => this.version
  private bump() {
    this.version++
    this.listeners.forEach((l) => l())
  }

  registerFile(key: string, file: File, handle?: any) {
    this.files.set(key, file)
    if (handle) set(key, handle, handleStore).catch(() => {})
    this.bump()
  }

  registerDir(key: string, source: DirSource, handle?: any) {
    this.dirs.set(key, source)
    if (handle) set(key, handle, handleStore).catch(() => {})
    this.bump()
  }

  forget(key: string) {
    this.files.delete(key)
    this.dirs.delete(key)
    del(key, handleStore).catch(() => {})
    this.bump()
  }

  isReady(key: string) {
    return this.files.has(key) || this.dirs.has(key)
  }

  /** Restores a persisted handle if permission is still granted (no prompt, no gesture needed). */
  async probe(key: string): Promise<boolean> {
    if (this.isReady(key)) return true
    try {
      const h: any = await get(key, handleStore)
      if (!h) return false
      if ((await h.queryPermission?.({ mode: 'read' })) !== 'granted') return false
      await this.adopt(key, h)
      return true
    } catch {
      return false
    }
  }

  /** Needs a user gesture: asks the browser to re-grant a stored handle. */
  async reauthorize(key: string): Promise<boolean> {
    try {
      const h: any = await get(key, handleStore)
      if (!h) return false
      if ((await h.requestPermission?.({ mode: 'read' })) !== 'granted') return false
      await this.adopt(key, h)
      return true
    } catch {
      return false
    }
  }

  private async adopt(key: string, h: any) {
    if (h.kind === 'directory') this.dirs.set(key, new HandleDir(h))
    else this.files.set(key, await h.getFile())
    this.bump()
  }

  async getFile(key: string): Promise<File | null> {
    if (!this.files.has(key)) await this.probe(key)
    const f = this.files.get(key) ?? null
    if (!f) return null
    // Chromium File objects go stale if the file changed/moved; fail soft and force relink
    return f
  }

  async getDir(key: string): Promise<DirSource | null> {
    if (!this.dirs.has(key)) await this.probe(key)
    return this.dirs.get(key) ?? null
  }
}
