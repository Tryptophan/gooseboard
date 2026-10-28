import { canDirPicker, canOpenPicker, mimeOf } from '../lib/files'
import { bounds, rectsIntersect, type Vec } from '../lib/geometry'
import { newItemId } from '../lib/ids'
import { toast } from '../lib/toast'
import type { Session } from '../net/session'
import { FileListDir, HandleDir, readEntryTree, type DirSource } from '../net/sources'
import { MEDIA_SIDE, mediaBox } from '../lib/media'
import { blobToDataURL, makeThumb, mediaSize } from '../net/thumbs'
import { DEFAULT_SIZE, FOLDER_COLORS } from './types'

export type DropItem =
  | { kind: 'file'; file: File; handle?: any; keep?: boolean }
  | { kind: 'dir'; name: string; source: DirSource; handle?: any }

const pad = (n: number) => String(n).padStart(2, '0')

/** Clipboard files, kept in IndexedDB; browsers name screenshots 'image.png', so those get a timestamp. */
export function pastedItems(files: File[]): DropItem[] {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`
  return files.map((f) => {
    const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? f.type.split('/')[1]?.replace(/\W.*/, '') ?? 'bin'
    const generic = !f.name || /^(image|blob|untitled|clipboard)(\.[a-z0-9]+)?$/i.test(f.name)
    const file = generic ? new File([f], `Pasted ${stamp}.${ext === 'jpeg' ? 'jpg' : ext}`, { type: f.type, lastModified: f.lastModified }) : f
    return { kind: 'file', file, keep: true }
  })
}

/** Must be called synchronously inside the drop event (DataTransfer is cleared afterwards). */
export async function readDrop(dt: DataTransfer): Promise<DropItem[]> {
  const jobs: Promise<DropItem | null>[] = []
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue
    const handleP: Promise<any> | undefined = (item as any).getAsFileSystemHandle?.()
    const entry = (item as any).webkitGetAsEntry?.()
    const file = item.getAsFile()
    jobs.push(
      (async (): Promise<DropItem | null> => {
        const handle = handleP ? await handleP.catch(() => null) : null
        if (handle?.kind === 'directory') return { kind: 'dir', name: handle.name, source: new HandleDir(handle), handle }
        if (handle?.kind === 'file') return { kind: 'file', file: await handle.getFile(), handle }
        if (entry?.isDirectory) {
          const t = await readEntryTree(entry)
          return { kind: 'dir', name: t.name, source: t.source }
        }
        return file ? { kind: 'file', file } : null
      })(),
    )
  }
  return (await Promise.all(jobs)).filter((x): x is DropItem => !!x)
}

function pickWithInput(opts: { multiple?: boolean; directory?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = !!opts.multiple
    if (opts.directory) input.setAttribute('webkitdirectory', '')
    input.style.display = 'none'
    input.onchange = () => {
      resolve(Array.from(input.files ?? []))
      input.remove()
    }
    input.oncancel = () => {
      resolve([])
      input.remove()
    }
    document.body.appendChild(input)
    input.click()
  })
}

export async function pickFiles(multiple = true): Promise<DropItem[]> {
  if (canOpenPicker()) {
    try {
      const hs: any[] = await (window as any).showOpenFilePicker({ multiple })
      return await Promise.all(hs.map(async (h) => ({ kind: 'file' as const, file: await h.getFile(), handle: h })))
    } catch {
      return []
    }
  }
  return (await pickWithInput({ multiple })).map((file) => ({ kind: 'file' as const, file }))
}

export async function pickDirectory(): Promise<DropItem | null> {
  if (canDirPicker()) {
    try {
      const h = await (window as any).showDirectoryPicker({ mode: 'read' })
      return { kind: 'dir', name: h.name, source: new HandleDir(h), handle: h }
    } catch {
      return null
    }
  }
  const files = await pickWithInput({ directory: true })
  if (!files.length) return null
  const { name, source } = FileListDir.fromInput(files)
  return { kind: 'dir', name, source }
}

async function thumbFor(file: File): Promise<string | undefined> {
  let b = await makeThumb(file, 256)
  if (b && b.size > 40_000) b = await makeThumb(file, 128)
  return b && b.size <= 60_000 ? blobToDataURL(b) : undefined
}

/** Nearest spot to `at` (spiralling outwards) where a w x h card overlaps no existing board card. */
export function freeSpot(s: Pick<Session, 'store'>, at: Vec, w: number, h: number): Vec {
  const cards = s.store.getSnapshot().surface.filter((i) => i.type !== 'stroke').map(bounds)
  const gap = 24
  for (let ring = 0; ring < 12; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const x = at.x - w / 2 + dx * (w + gap)
        const y = at.y - h / 2 + dy * (h + gap)
        if (!cards.some((c) => rectsIntersect({ x: x - gap / 2, y: y - gap / 2, w: w + gap, h: h + gap }, c))) return { x, y }
      }
    }
  }
  return { x: at.x - w / 2, y: at.y - h / 2 }
}

/**
 * Registers dropped/picked things as shared items served from this device. `avoidOverlap`
 * (toolbar adds) finds free space; drops land exactly where released, extra files in a grid.
 */
export async function addDropItems(
  s: Session,
  items: DropItem[],
  at: Vec,
  parent: string | null = null,
  opts: { avoidOverlap?: boolean } = {},
): Promise<string[]> {
  const ids: string[] = []
  const { id: owner, name: ownerName } = s.profile
  let n = 0
  for (const it of items) {
    // pictures and videos land bare, at their own aspect
    const dims = it.kind === 'file' ? await mediaSize(it.file) : null
    const sz = dims ? mediaBox(dims.w, dims.h) : DEFAULT_SIZE[it.kind === 'file' ? 'file' : 'folder']
    const col = n % 4
    const row = Math.floor(n / 4)
    // grid cells fit any picture, so a mixed drop doesn't overlap
    const cell = dims ? { w: MEDIA_SIDE, h: MEDIA_SIDE } : sz
    const pos =
      opts.avoidOverlap && !parent
        ? freeSpot(s, { x: at.x + col * (cell.w + 20), y: at.y + row * (cell.h + 20) }, sz.w, sz.h)
        : { x: at.x - sz.w / 2 + col * (cell.w + 20), y: at.y - sz.h / 2 + row * (cell.h + 20) }
    n++
    const key = newItemId()
    if (it.kind === 'file') {
      s.sources.registerFile(key, it.file, it.handle, it.keep ? s.id : undefined)
      ids.push(
        s.store.add({
          type: 'file', name: it.file.name, size: it.file.size, mime: mimeOf(it.file.name, it.file.type),
          owner, ownerName, key, thumb: await thumbFor(it.file), x: Math.round(pos.x), y: Math.round(pos.y), parent,
          ...(dims && { iw: dims.w, ih: dims.h, w: sz.w, h: sz.h }),
        }),
      )
    } else {
      s.sources.registerDir(key, it.source, it.handle)
      ids.push(
        s.store.add({
          type: 'folder', mode: 'disk', name: it.name, owner, ownerName, key, color: FOLDER_COLORS[1],
          x: Math.round(pos.x), y: Math.round(pos.y), parent,
        }),
      )
    }
  }
  return ids
}

/** Owner re-selects the file/folder behind a shared item so peers' pending requests resume. */
export async function relink(s: Session, key: string, kind: 'file' | 'dir', expectName?: string) {
  if (await s.sources.reauthorize(key)) {
    s.p2p.dropThumbs(key)
    s.p2p.relinked(key)
    return true
  }
  if (kind === 'file') {
    const [pick] = await pickFiles(false)
    if (!pick || pick.kind !== 'file') return false
    if (expectName && pick.file.name !== expectName) toast(`Linked "${pick.file.name}" (expected "${expectName}")`)
    s.sources.registerFile(key, pick.file, pick.handle)
  } else {
    const pick = await pickDirectory()
    if (!pick || pick.kind !== 'dir') return false
    s.sources.registerDir(key, pick.source, pick.handle)
  }
  s.p2p.dropThumbs(key)
  s.p2p.relinked(key)
  return true
}

