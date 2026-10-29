import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useBackTrail } from '../lib/back'
import { DOWNLOAD_TIP, formatSize, kindOf } from '../lib/files'
import type { Vec } from '../lib/geometry'
import { toast } from '../lib/toast'
import { lastWasTouch, longPressMenu, useCoarse } from '../lib/touch'
import { normalizeUrl } from '../lib/url'
import { addDropItems, pickFiles, readDrop } from '../model/actions'
import { fragmentToText } from '../model/noteSchema'
import type { FolderItem, Item } from '../model/types'
import { FOLDER_COLORS, NOTE_COLORS } from '../model/types'
import { folderAlias } from '../net/mirror'
import type { Session } from '../net/session'
import type { DirEntry } from '../net/sources'
import { useCamera } from '../state/camera'
import { usePeers, useSession, useSnapshot } from '../state/session'
import { useUi, useUiDispatch } from '../state/ui'
import { openMenu } from './ContextMenu'
import { promptDialog } from './Dialog'
import { safeThumb } from './FileCard'
import { Icon } from './Icons'
import { canPreview, usePreview } from './Preview'
import { TypeIcon, VideoPoster } from './TypeIcon'
import s from './FolderPanel.module.css'

/** how long an entry stays in view before its thumbnail is asked for */
const THUMB_DWELL_MS = 150

export function FolderPanel() {
  const ui = useUi()
  const snap = useSnapshot()
  const dispatch = useUiDispatch()
  const folder = ui.openFolder ? snap.all.get(ui.openFolder) : undefined
  // back steps out to the folder before, then to the board
  useBackTrail(ui.openFolder, null, (id) => dispatch({ type: 'folder', id }))
  if (!folder || folder.type !== 'folder') return null
  return <Shell key={folder.id} folder={folder} />
}

// ---------- dragging out of the panel ----------

/**
 * Pointer-driven (not HTML5 drag and drop, which the board already uses for OS files):
 * tiles drag onto a folder tile, a breadcrumb, a folder on the board or the board itself.
 * Folder tiles and breadcrumbs carry data-drop="<folder id>".
 */
type Payload = { kind: 'item'; item: Item; label: string } | { kind: 'entry'; folder: FolderItem; entry: DirEntry; path: string; label: string }

type Target = { folder: string } | { surface: Vec } | null

type StartDrag = (e: RPointerEvent, p: Payload) => void

function surfacePoint(x: number, y: number, cam: ReturnType<typeof useCamera>): Vec | null {
  const host = document.querySelector<HTMLElement>('[data-board-surface]')
  if (!host) return null
  const r = host.getBoundingClientRect()
  return cam.screenToWorld(x - r.left, y - r.top)
}

function useDrag(session: Session, cam: ReturnType<typeof useCamera>) {
  const { store } = session
  const dispatch = useUiDispatch()
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const surfaceHover = useRef<HTMLElement | null>(null)

  const targetAt = useCallback(
    (x: number, y: number, p: Payload): { target: Target; key: string | null; el?: HTMLElement } => {
      const els = document.elementsFromPoint(x, y) as HTMLElement[]
      const drop = els.map((el) => el.closest<HTMLElement>('[data-drop]')).find(Boolean)
      const own = p.kind === 'item' ? p.item.id : null
      // drawings only live on the board
      const drawing = p.kind === 'item' && p.item.type === 'stroke'
      if (drop) {
        if (drawing) return { target: null, key: null }
        const d = drop.dataset.drop!
        return d === own ? { target: null, key: null } : { target: { folder: d }, key: d }
      }
      // anywhere else in the panel (or other chrome) is not a target
      if (els[0]?.closest('[data-nodrag]')) return { target: null, key: null }
      const itemEl = els.map((el) => el.closest<HTMLElement>('[data-item-id]')).find(Boolean)
      const it = itemEl ? store.getSnapshot().all.get(itemEl.dataset.itemId!) : undefined
      if (it?.type === 'folder' && it.mode === 'virtual' && it.id !== own && !drawing) return { target: { folder: it.id }, key: it.id, el: itemEl! }
      if (!els.some((el) => el.closest('[data-board-surface]'))) return { target: null, key: null }
      const wp = surfacePoint(x, y, cam)
      return wp ? { target: { surface: wp }, key: null } : { target: null, key: null }
    },
    [store, cam],
  )

  const drop = useCallback(
    async (p: Payload, t: Target) => {
      if (!t) return
      const folderName = (id: string) => {
        const f = store.getSnapshot().all.get(id)
        return f?.type === 'folder' ? f.name : 'folder'
      }
      if (p.kind === 'item') {
        const it = p.item
        if ('folder' in t) {
          if (t.folder === it.parent) return
          if (store.isDescendant(t.folder, it.id)) return toast('A folder can’t go inside itself')
          store.undo.stopCapturing()
          store.reparent([it.id], t.folder)
          toast(`Moved “${p.label}” into “${folderName(t.folder)}”`)
        } else {
          store.undo.stopCapturing()
          store.update(it.id, { parent: null, x: Math.round(t.surface.x - it.w / 2), y: Math.round(t.surface.y - it.h / 2) })
          dispatch({ type: 'select', ids: [it.id] })
        }
        return
      }
      const ids = await copyEntryOut(session, p.folder, p.entry, p.path, 'folder' in t ? { x: 0, y: 0 } : t.surface, 'folder' in t ? t.folder : null)
      if (!ids) return
      if ('folder' in t) toast(`Copied “${p.entry.name}” into “${folderName(t.folder)}”`)
      else dispatch({ type: 'select', ids })
    },
    [session, store, dispatch],
  )

  const setSurfaceHover = (el: HTMLElement | null) => {
    if (surfaceHover.current === el) return
    surfaceHover.current?.removeAttribute('data-drop-hover')
    el?.setAttribute('data-drop-hover', '')
    surfaceHover.current = el
  }

  const start: StartDrag = (e, p) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input')) return
    const sx = e.clientX
    const sy = e.clientY
    let dragging = false
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return
      dragging = true
      setGhost({ x: ev.clientX, y: ev.clientY, label: p.label })
      const t = targetAt(ev.clientX, ev.clientY, p)
      setHover(t.key)
      setSurfaceHover(t.el ?? null)
    }
    const end = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      setGhost(null)
      setHover(null)
      setSurfaceHover(null)
      if (dragging && ev.type === 'pointerup') void drop(p, targetAt(ev.clientX, ev.clientY, p).target)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  return { start, ghost, hover }
}

/** Disk folders are read-only listings, so a file dragged out becomes a copy shared by whoever dragged it. */
async function copyEntryOut(session: Session, folder: FolderItem, entry: DirEntry, path: string, at: Vec, parent: string | null): Promise<string[] | null> {
  if (entry.kind !== 'file') {
    toast('Only files can be copied out of a disk folder')
    return null
  }
  try {
    let got = folder.owner === session.profile.id ? await session.sources.fileIn(folder.key ?? '', path).catch(() => null) : null
    if (!got) {
      toast(`Copying “${entry.name}”…`)
      const req = { op: 'file', kind: 'dir', key: folder.key ?? '', path, alias: folderAlias(folder.key ?? '', path, entry.size, entry.mtime) } as const
      const blob = await session.files.getBlob(folder.owner, req)
      got = { file: new File([blob], entry.name, { type: entry.mime || blob.type, lastModified: entry.mtime }) }
    }
    return await addDropItems(session, [{ kind: 'file', file: got.file, handle: got.handle }], at, parent)
  } catch (e) {
    toast(`Couldn’t copy “${entry.name}”: ${(e as Error).message === 'unreachable' ? `${folder.ownerName} is offline` : (e as Error).message}`)
    return null
  }
}

// ---------- shell: header, breadcrumbs, back ----------

function Shell({ folder }: { folder: FolderItem }) {
  const session = useSession()
  const { store } = session
  const snap = useSnapshot()
  const cam = useCamera()
  const dispatch = useUiDispatch()
  const [name, setName] = useState<string | null>(null)
  // sub-directory inside a disk folder
  const [path, setPath] = useState<string[]>([])
  useBackTrail(path.join('/'), '', (p) => setPath(p ? p.split('/') : []))
  const drag = useDrag(session, cam)

  const ancestors: FolderItem[] = []
  for (let p = folder.parent ? snap.all.get(folder.parent) : undefined; p && p.type === 'folder' && ancestors.length < 20; p = p.parent ? snap.all.get(p.parent) : undefined) ancestors.unshift(p)
  const parent = ancestors[ancestors.length - 1]

  const back = () => {
    if (path.length) setPath(path.slice(0, -1))
    else dispatch({ type: 'folder', id: parent?.id ?? null })
  }
  const virtual = folder.mode === 'virtual'
  const crumb = (id: string, droppable: boolean) => `${droppable && drag.hover === id ? s.dropOn : ''}`

  return (
    <aside
      className={s.panel}
      data-nodrag
      data-folder-panel
      onKeyDown={(e) => {
        // Backspace / Alt+Left go back, like a file browser
        if ((e.target as HTMLElement).closest('input')) return
        if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft')) {
          e.preventDefault()
          e.stopPropagation()
          back()
        }
      }}
    >
      <header>
        <nav className={s.crumbs} aria-label="Folder path">
          <button className={s.back} onClick={back} title={path.length || parent ? 'Back' : 'Back to the board'} aria-label="Back">
            <Icon name="up" size={15} />
          </button>
          {/* the outermost folder is the root of the path */}
          {ancestors.map((c, i) => (
            <span key={c.id} className={s.crumb}>
              {i > 0 && <i>/</i>}
              <button data-drop={c.mode === 'virtual' ? c.id : undefined} className={crumb(c.id, c.mode === 'virtual')} onClick={() => dispatch({ type: 'folder', id: c.id })}>
                {c.name}
              </button>
            </span>
          ))}
          <span className={s.crumb}>
            {ancestors.length > 0 && <i>/</i>}
            <button data-drop={virtual ? folder.id : undefined} className={`${path.length ? '' : s.here} ${crumb(folder.id, virtual)}`} onClick={() => setPath([])}>
              {folder.name}
            </button>
          </span>
          {path.map((p, i) => (
            <span key={i} className={s.crumb}>
              <i>/</i>
              <button className={i === path.length - 1 ? s.here : ''} onClick={() => setPath(path.slice(0, i + 1))}>
                {p}
              </button>
            </span>
          ))}
        </nav>
        <div className={s.titleRow}>
          <Icon name={folder.mode === 'disk' ? 'disk' : 'folder'} size={20} />
          <input
            value={name ?? folder.name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (name !== null && name.trim()) store.update(folder.id, { name: name.trim() })
              setName(null)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
          <div className={s.colors}>
            {FOLDER_COLORS.map((c) => (
              <button key={c} style={{ background: c }} className={folder.color === c ? s.colorOn : ''} onClick={() => store.update(folder.id, { color: c })} aria-label={`Color ${c}`} />
            ))}
          </div>
          <button className={s.close} onClick={() => dispatch({ type: 'folder', id: null })} aria-label="Close folder">
            <Icon name="close" size={18} />
          </button>
        </div>
      </header>
      {virtual ? (
        <VirtualBody folder={folder} drag={drag.start} hover={drag.hover} />
      ) : (
        <DiskBody folder={folder} path={path} setPath={setPath} drag={drag.start} />
      )}
      {drag.ghost && (
        <div className={s.ghost} style={{ left: drag.ghost.x, top: drag.ghost.y }}>
          {drag.ghost.label}
        </div>
      )}
    </aside>
  )
}

// ---------- virtual folders ----------

function VirtualBody({ folder, drag, hover }: { folder: FolderItem; drag: StartDrag; hover: string | null }) {
  const session = useSession()
  const { store, profile } = session
  const snap = useSnapshot()
  const cam = useCamera()
  const dispatch = useUiDispatch()
  const [over, setOver] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const coarse = useCoarse()
  const kids = snap.children.get(folder.id) ?? []

  const add = (init: Record<string, any> & { type: Item['type'] }) => store.add({ ...init, parent: folder.id })

  const sendOut = (it: Item) => {
    const c = cam.viewCenter()
    store.update(it.id, { parent: null, x: Math.round(c.x - it.w / 2 + (Math.random() - 0.5) * 80), y: Math.round(c.y - it.h / 2 + (Math.random() - 0.5) * 80) })
    dispatch({ type: 'select', ids: [it.id] })
  }

  return (
    <div
      className={`${s.body} ${over ? s.over : ''}`}
      onPointerDown={(e) => e.target === e.currentTarget && setSelected(null)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault()
        setOver(false)
        const items = await readDrop(e.dataTransfer)
        await addDropItems(session, items, { x: 0, y: 0 }, folder.id)
      }}
    >
      <div className={s.actions}>
        <button onClick={() => add({ type: 'note', color: NOTE_COLORS[0] })}>
          <Icon name="note" size={15} /> Note
        </button>
        <button
          onClick={async () => {
            const raw = await promptDialog({ title: 'Add a link', placeholder: 'https://…', ok: 'Add' })
            if (raw === null) return
            const u = normalizeUrl(raw)
            if (u) add({ type: 'link', url: u })
            else toast('Only http(s) links can be added')
          }}
        >
          <Icon name="link" size={15} /> Link
        </button>
        <button onClick={() => add({ type: 'folder', mode: 'virtual', name: 'New folder', owner: profile.id, ownerName: profile.name, color: FOLDER_COLORS[0] })}>
          <Icon name="folder" size={15} /> Folder
        </button>
        <button
          onClick={async () => {
            const items = await pickFiles(true)
            if (items.length) await addDropItems(session, items, { x: 0, y: 0 }, folder.id)
          }}
        >
          <Icon name="file" size={15} /> Files
        </button>
      </div>
      {kids.length === 0 ? (
        <p className={s.hint}>Empty. Drop files here, or drag items from the board onto the folder.</p>
      ) : (
        <>
          <div className={s.grid}>
            {kids.map((k) => (
              <Child
                key={k.id}
                item={k}
                selected={selected === k.id}
                dropOn={hover === k.id}
                onSelect={() => setSelected(k.id)}
                drag={drag}
                onOpenFolder={() => dispatch({ type: 'folder', id: k.id })}
                onOut={() => sendOut(k)}
                onDelete={() => {
                  store.undo.stopCapturing()
                  store.remove([k.id])
                }}
              />
            ))}
          </div>
          <p className={s.hint}>{coarse ? 'Tap to open, hold for more.' : 'Double-click to open. Drag onto the board, a folder, or the path above to move.'}</p>
        </>
      )}
    </div>
  )
}

interface ChildProps {
  item: Item
  selected: boolean
  dropOn: boolean
  onSelect: () => void
  drag: StartDrag
  onOpenFolder: () => void
  onOut: () => void
  onDelete: () => void
}

function Child({ item, selected, dropOn, onSelect, drag, onOpenFolder, onOut, onDelete }: ChildProps) {
  const { store, files } = useSession()
  const dispatch = useUiDispatch()
  const preview = usePreview()
  let body: React.ReactNode = null
  let title = ''
  let sub = ''
  const fileArgs =
    item.type === 'file'
      ? { item, ownerId: item.owner, ownerName: item.ownerName, req: { op: 'file', kind: 'file', key: item.key, hash: item.hash } as const, name: item.name, size: item.size, mime: item.mime }
      : null
  const canPrev = !!fileArgs && canPreview(fileArgs.name, fileArgs.mime, fileArgs.size)
  const url = item.type === 'link' ? normalizeUrl(item.url) : null

  if (item.type === 'note') {
    const f = store.noteFragment(item.id)
    body = <div className={s.noteText} style={{ background: item.color }}>{(f ? fragmentToText(f) : '').slice(0, 160) || 'Empty note'}</div>
    title = item.title || 'Note'
  } else if (item.type === 'file') {
    const t = safeThumb(item.thumb)
    body = (
      <div className={s.thumb}>
        {t ? <img src={t} alt="" draggable={false} /> : kindOf(item.name, item.mime) === 'video' ? <VideoPoster name={item.name} /> : <TypeIcon name={item.name} mime={item.mime} size={44} />}
      </div>
    )
    title = item.name
    sub = `${formatSize(item.size)} · ${item.ownerName}`
  } else if (item.type === 'folder') {
    body = <div className={s.folderBtn} style={{ background: item.color }}><Icon name={item.mode === 'disk' ? 'disk' : 'folder'} size={28} /></div>
    title = item.name
    sub = item.mode === 'disk' ? 'Disk folder' : 'Folder'
  } else if (item.type === 'link') {
    body = <div className={s.thumb}><Icon name="link" size={28} /></div>
    title = item.url ? (url ? new URL(url).host : 'Blocked link') : 'Empty link'
    sub = item.url
  } else body = <div className={s.thumb}><Icon name="pen" size={26} /></div>

  const open = () => {
    if (item.type === 'folder') onOpenFolder()
    else if (item.type === 'note') dispatch({ type: 'noteModal', id: item.id })
    else if (fileArgs) {
      if (canPrev) preview(fileArgs)
      else void files.download(fileArgs)
    } else if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }
  const opens = item.type === 'folder' || item.type === 'note' || !!fileArgs || !!url

  return (
    <div
      className={`${s.child} ${selected ? s.selected : ''} ${dropOn ? s.dropOn : ''}`}
      tabIndex={0}
      data-drop={item.type === 'folder' && item.mode === 'virtual' ? item.id : undefined}
      onPointerDown={(e) => {
        onSelect()
        longPressMenu(e)
        drag(e, { kind: 'item', item, label: title || 'Item' })
      }}
      // touch: one tap opens (long-press is the menu)
      onClick={(e) => lastWasTouch() && !(e.target as HTMLElement).closest('button, a') && open()}
      onDoubleClick={(e) => !lastWasTouch() && !(e.target as HTMLElement).closest('button, a') && open()}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        // handled here, not by the board shortcuts underneath
        if (e.key === 'Enter') {
          e.stopPropagation()
          open()
        } else if (e.key === 'Delete') {
          e.stopPropagation()
          onDelete()
        }
      }}
      onContextMenu={(e) => {
        onSelect()
        openMenu(e, [
          opens && { label: item.type === 'folder' ? 'Open' : item.type === 'note' ? 'Open note' : canPrev ? 'Preview' : url ? 'Open link' : 'Download', icon: item.type === 'folder' ? 'folder' : item.type === 'note' ? 'expand' : canPrev ? 'eye' : url ? 'link' : 'download', hint: 'Enter', onSelect: open },
          canPrev && fileArgs && { label: 'Download', icon: 'download', onSelect: () => void files.download(fileArgs) },
          item.type === 'note' && 'sep',
          item.type === 'note' && {
            swatches: NOTE_COLORS,
            value: item.color,
            onPick: (color) => {
              store.undo.stopCapturing()
              store.update(item.id, { color })
            },
          },
          item.type === 'folder' && {
            label: 'Rename…',
            onSelect: async () => {
              const n = await promptDialog({ title: 'Rename folder', value: item.name, ok: 'Rename' })
              if (n) store.update(item.id, { name: n })
            },
          },
          'sep',
          { label: 'Move onto the board', icon: 'up', onSelect: onOut },
          'sep',
          { label: 'Delete', icon: 'trash', hint: 'Del', danger: true, onSelect: onDelete },
        ])
      }}
    >
      {body}
      <div className={s.childName} title={title}>{title}</div>
      {sub && <div className={s.childSub} title={sub}>{sub}</div>}
      <div className={s.childActions}>
        {canPrev && fileArgs && (
          <button title="Preview" onClick={() => preview(fileArgs)}>
            <Icon name="eye" size={14} />
          </button>
        )}
        {fileArgs && (
          <button title={DOWNLOAD_TIP} onClick={() => void files.download(fileArgs)}>
            <Icon name="download" size={14} />
          </button>
        )}
        {url && (
          <a title="Open" href={url} target="_blank" rel="noopener noreferrer"><Icon name="link" size={14} /></a>
        )}
        {item.type === 'note' && (
          <button
            title="Colour"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              openMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, [
                { swatches: NOTE_COLORS, value: item.color, onPick: (color) => (store.undo.stopCapturing(), store.update(item.id, { color })) },
              ])
            }}
          >
            <span className={s.colorDot} style={{ background: item.color }} />
          </button>
        )}
                <button title="Move onto the board" onClick={onOut}><Icon name="up" size={14} /></button>
        <button title="Delete" onClick={onDelete}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  )
}

// ---------- disk folders (listed and fetched live from the owner) ----------

function DiskBody({ folder, path, setPath, drag }: { folder: FolderItem; path: string[]; setPath: (p: string[]) => void; drag: StartDrag }) {
  const { files, profile } = useSession()
  const { online } = usePeers()
  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [tick, setTick] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const coarse = useCoarse()
  const mine = folder.owner === profile.id
  const rel = path.join('/')

  useEffect(() => {
    let dead = false
    setEntries(null)
    setErr(null)
    setSelected(null)
    setNote(mine || online.has(folder.owner) ? 'Loading…' : `Waiting for ${folder.ownerName} to come online…`)
    files
      .list(folder.owner, folder.key ?? '', rel, (st) => !dead && setNote(st === 'waiting-relink' ? `Waiting for ${folder.ownerName} to relink this folder…` : st === 'waiting-owner' ? `Waiting for ${folder.ownerName} to come online…` : 'Loading…'))
      .then((e) => !dead && setEntries(e))
      .catch((e) => !dead && setErr((e as Error).message === 'unreachable' ? `${folder.ownerName} is offline or unreachable.` : (e as Error).message))
    return () => {
      dead = true
    }
  }, [files, folder.owner, folder.key, folder.ownerName, rel, tick, mine, online])

  return (
    <div className={s.body} onPointerDown={(e) => e.target === e.currentTarget && setSelected(null)}>
      <div className={s.actions}>
        <p className={s.hint}>
          {mine
            ? 'Served from your disk.'
            : online.has(folder.owner)
              ? `Browsing ${folder.ownerName}’s disk live: files are streamed peer-to-peer only when you open or download them.`
              : `${folder.ownerName} is offline: showing the last listing seen. Files open if someone online has a copy.`}
        </p>
        <button onClick={() => setTick(tick + 1)} title="Fetch the listing again">
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {err ? (
        <p className={s.error}>{err}</p>
      ) : !entries ? (
        <p className={s.hint}>{note}</p>
      ) : entries.length === 0 ? (
        <p className={s.hint}>This folder is empty.</p>
      ) : (
        <>
          <div className={s.grid}>
            {entries.map((e) => (
              <Entry
                key={e.name}
                folder={folder}
                entry={e}
                path={rel ? `${rel}/${e.name}` : e.name}
                selected={selected === e.name}
                onSelect={() => setSelected(e.name)}
                drag={drag}
                onOpen={() => setPath([...path, e.name])}
              />
            ))}
          </div>
          <p className={s.hint}>{coarse ? 'Tap to open, hold for more.' : 'Double-click to open. Drag a file onto the board or a folder to add a copy.'}</p>
        </>
      )}
    </div>
  )
}

interface EntryProps {
  folder: FolderItem
  entry: DirEntry
  path: string
  selected: boolean
  onSelect: () => void
  drag: StartDrag
  onOpen: () => void
}

function Entry({ folder, entry, path, selected, onSelect, drag, onOpen }: EntryProps) {
  const session = useSession()
  const { files } = session
  const cam = useCamera()
  const dispatch = useUiDispatch()
  const preview = usePreview()
  const ref = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<string | null>(null)
  const kind = kindOf(entry.name, entry.mime)
  const isFile = entry.kind === 'file'
  const wantsThumb = isFile && (kind === 'image' || kind === 'video')

  // thumbnails only for entries that stay in view a moment (a fast scroll asks for nothing), and
  // asked for again if one scrolls away before it arrives (the owner then needn't make it)
  useEffect(() => {
    if (!wantsThumb || !ref.current) return
    let wait: ReturnType<typeof setTimeout> | undefined
    let ctl: AbortController | null = null
    const io = new IntersectionObserver(([x]) => {
      clearTimeout(wait)
      if (!x?.isIntersecting) {
        ctl?.abort()
        ctl = null
        return
      }
      wait = setTimeout(() => {
        const c = (ctl = new AbortController())
        void files.thumbURL(folder.owner, folder.key ?? '', 'dir', path, c.signal).then((u) => {
          if (c.signal.aborted) return
          setThumb(u)
          ctl = null
          io.disconnect()
        })
      }, THUMB_DWELL_MS)
    })
    io.observe(ref.current)
    return () => {
      clearTimeout(wait)
      ctl?.abort()
      io.disconnect()
    }
  }, [wantsThumb, files, folder.owner, folder.key, path])

  const req = { op: 'file', kind: 'dir', key: folder.key ?? '', path, alias: folderAlias(folder.key ?? '', path, entry.size, entry.mtime) } as const
  const args = { ownerId: folder.owner, ownerName: folder.ownerName, req, name: entry.name, size: entry.size, mime: entry.mime }
  const canPrev = isFile && canPreview(entry.name, entry.mime, entry.size)
  const open = () => (!isFile ? onOpen() : canPrev ? preview(args) : void files.download(args))
  const copyOut = async () => {
    const ids = await copyEntryOut(session, folder, entry, path, cam.viewCenter(), null)
    if (ids) dispatch({ type: 'select', ids })
  }

  return (
    <div
      className={`${s.child} ${selected ? s.selected : ''}`}
      ref={ref}
      tabIndex={0}
      onPointerDown={(e) => {
        onSelect()
        longPressMenu(e)
        if (isFile) drag(e, { kind: 'entry', folder, entry, path, label: entry.name })
      }}
      onClick={(e) => lastWasTouch() && !(e.target as HTMLElement).closest('button') && open()}
      onDoubleClick={(e) => !lastWasTouch() && !(e.target as HTMLElement).closest('button') && open()}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.target !== e.currentTarget) return
        e.stopPropagation()
        open()
      }}
      onContextMenu={(e) => {
        onSelect()
        openMenu(e, [
          { label: !isFile ? 'Open' : canPrev ? 'Preview' : 'Download', icon: !isFile ? 'folder' : canPrev ? 'eye' : 'download', hint: 'Enter', onSelect: open },
          canPrev && { label: 'Download', icon: 'download', onSelect: () => void files.download(args) },
          isFile && 'sep',
          isFile && { label: 'Copy onto the board', icon: 'copy', onSelect: () => void copyOut() },
        ])
      }}
    >
      {!isFile ? (
        <div className={s.folderBtn} style={{ background: folder.color }}>
          <Icon name="folder" size={28} />
        </div>
      ) : (
        <div className={s.thumb}>
          {thumb ? <img src={thumb} alt="" draggable={false} /> : kind === 'video' ? <VideoPoster name={entry.name} /> : <TypeIcon name={entry.name} mime={entry.mime} size={44} />}
        </div>
      )}
      <div className={s.childName} title={entry.name}>{entry.name}</div>
      <div className={s.childSub}>{!isFile ? 'Folder' : formatSize(entry.size)}</div>
      {isFile && (
        <div className={s.childActions}>
          {canPrev && (
            <button title="Preview" onClick={() => preview(args)}>
              <Icon name="eye" size={14} />
            </button>
          )}
          <button title={DOWNLOAD_TIP} onClick={() => void files.download(args)}>
            <Icon name="download" size={14} />
          </button>
          <button title="Copy onto the board" onClick={() => void copyOut()}>
            <Icon name="copy" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
