import { useCallback, useEffect, useRef, useState } from 'react'
import { formatSize, kindOf } from '../lib/files'
import { normalizeUrl } from '../lib/url'
import { addDropItems, pickFiles, readDrop } from '../model/actions'
import { fragmentToText } from '../model/noteSchema'
import type { FolderItem, Item } from '../model/types'
import { FOLDER_COLORS, NOTE_COLORS } from '../model/types'
import { folderAlias } from '../net/mirror'
import type { DirEntry } from '../net/sources'
import { useCamera } from '../state/camera'
import { usePeers, useSession, useSnapshot } from '../state/session'
import { useUi, useUiDispatch } from '../state/ui'
import { safeThumb } from './FileCard'
import { Icon } from './Icons'
import { canPreview, usePreview } from './Preview'
import { TypeIcon } from './TypeIcon'
import s from './FolderPanel.module.css'

export function FolderPanel() {
  const ui = useUi()
  const snap = useSnapshot()
  const folder = ui.openFolder ? snap.all.get(ui.openFolder) : undefined
  if (!folder || folder.type !== 'folder') return null
  return <Shell key={folder.id} folder={folder} />
}

function Shell({ folder }: { folder: FolderItem }) {
  const { store } = useSession()
  const snap = useSnapshot()
  const dispatch = useUiDispatch()
  const [name, setName] = useState<string | null>(null)
  const crumbs: FolderItem[] = []
  for (let p = folder.parent ? snap.all.get(folder.parent) : undefined; p && p.type === 'folder' && crumbs.length < 8; p = p.parent ? snap.all.get(p.parent) : undefined) crumbs.unshift(p)

  return (
    <aside className={s.panel} data-nodrag>
      <header>
        <div className={s.crumbs}>
          {crumbs.map((c) => (
            <button key={c.id} onClick={() => dispatch({ type: 'folder', id: c.id })}>
              {c.name} /
            </button>
          ))}
        </div>
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
      {folder.mode === 'virtual' ? <VirtualBody folder={folder} /> : <DiskBody folder={folder} />}
    </aside>
  )
}

// ---------- virtual folders ----------

function VirtualBody({ folder }: { folder: FolderItem }) {
  const session = useSession()
  const { store, profile } = session
  const snap = useSnapshot()
  const cam = useCamera()
  const dispatch = useUiDispatch()
  const [over, setOver] = useState(false)
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
          onClick={() => {
            const u = normalizeUrl(window.prompt('Link URL') ?? '')
            if (u) add({ type: 'link', url: u })
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
        <p className={s.hint}>Empty. Drop files here, or drag items from the canvas onto the folder.</p>
      ) : (
        <div className={s.grid}>
          {kids.map((k) => (
            <Child key={k.id} item={k} onOpenFolder={() => dispatch({ type: 'folder', id: k.id })} onOut={() => sendOut(k)} onDelete={() => store.remove([k.id])} />
          ))}
        </div>
      )}
    </div>
  )
}

function Child({ item, onOpenFolder, onOut, onDelete }: { item: Item; onOpenFolder: () => void; onOut: () => void; onDelete: () => void }) {
  const { store, files } = useSession()
  const preview = usePreview()
  let body: React.ReactNode = null
  let title = ''
  let sub = ''
  if (item.type === 'note') {
    const f = store.noteFragment(item.id)
    body = <div className={s.noteText} style={{ background: item.color }}>{(f ? fragmentToText(f) : '').slice(0, 160) || 'Empty note'}</div>
    title = 'Note'
  } else if (item.type === 'file') {
    const t = safeThumb(item.thumb)
    body = <div className={s.thumb}>{t ? <img src={t} alt="" /> : <TypeIcon name={item.name} mime={item.mime} size={44} />}</div>
    title = item.name
    sub = `${formatSize(item.size)} · ${item.ownerName}`
  } else if (item.type === 'folder') {
    body = <button className={s.folderBtn} style={{ background: item.color }} onClick={onOpenFolder}><Icon name={item.mode === 'disk' ? 'disk' : 'folder'} size={28} /></button>
    title = item.name
    sub = item.mode === 'disk' ? 'Disk folder' : 'Folder'
  } else if (item.type === 'link') {
    body = <div className={s.thumb}><Icon name="link" size={28} /></div>
    title = item.url ? (normalizeUrl(item.url) ? new URL(normalizeUrl(item.url)!).host : 'Blocked link') : 'Empty link'
    sub = item.url
  } else body = <div className={s.thumb}><Icon name="pen" size={26} /></div>

  return (
    <div className={s.child}>
      {body}
      <div className={s.childName} title={title}>{title}</div>
      {sub && <div className={s.childSub} title={sub}>{sub}</div>}
      <div className={s.childActions}>
        {item.type === 'file' && canPreview(item.name, item.mime, item.size) && (
          <button title="Preview" onClick={() => preview({ ownerId: item.owner, ownerName: item.ownerName, req: { op: 'file', kind: 'file', key: item.key, hash: item.hash }, name: item.name, size: item.size, mime: item.mime })}>
            <Icon name="eye" size={14} />
          </button>
        )}
        {item.type === 'file' && (
          <button title="Download" onClick={() => void files.download({ ownerId: item.owner, ownerName: item.ownerName, req: { op: 'file', kind: 'file', key: item.key, hash: item.hash }, name: item.name, size: item.size })}>
            <Icon name="download" size={14} />
          </button>
        )}
        {item.type === 'link' && normalizeUrl(item.url) && (
          <a title="Open" href={normalizeUrl(item.url)!} target="_blank" rel="noopener noreferrer"><Icon name="link" size={14} /></a>
        )}
        <button title="Move onto the canvas" onClick={onOut}><Icon name="up" size={14} /></button>
        <button title="Delete" onClick={onDelete}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  )
}

// ---------- disk folders (listed and fetched live from the owner) ----------

function DiskBody({ folder }: { folder: FolderItem }) {
  const { files, profile } = useSession()
  const { online } = usePeers()
  const [path, setPath] = useState<string[]>([])
  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [tick, setTick] = useState(0)
  const mine = folder.owner === profile.id
  const rel = path.join('/')

  useEffect(() => {
    let dead = false
    setEntries(null)
    setErr(null)
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
    <div className={s.body}>
      <div className={s.actions}>
        <button disabled={!path.length} onClick={() => setPath(path.slice(0, -1))}>
          <Icon name="up" size={15} /> Up
        </button>
        <span className={s.path}>
          <button onClick={() => setPath([])}>{folder.name}</button>
          {path.map((p, i) => (
            <button key={i} onClick={() => setPath(path.slice(0, i + 1))}>
              / {p}
            </button>
          ))}
        </span>
        <button onClick={() => setTick(tick + 1)} title="Fetch the listing again">
          <Icon name="refresh" size={15} />
        </button>
      </div>
      <p className={s.hint}>
        {mine
          ? 'Served from your disk.'
          : online.has(folder.owner)
            ? `Browsing ${folder.ownerName}’s disk live: files are streamed peer-to-peer only when you open or download them.`
            : `${folder.ownerName} is offline: showing the last listing seen. Files open if someone online has a copy.`}
      </p>
      {err ? (
        <p className={s.error}>{err}</p>
      ) : !entries ? (
        <p className={s.hint}>{note}</p>
      ) : entries.length === 0 ? (
        <p className={s.hint}>This folder is empty.</p>
      ) : (
        <div className={s.grid}>
          {entries.map((e) => (
            <Entry key={e.name} folder={folder} entry={e} path={rel ? `${rel}/${e.name}` : e.name} onOpen={() => setPath([...path, e.name])} />
          ))}
        </div>
      )}
    </div>
  )
}

function Entry({ folder, entry, path, onOpen }: { folder: FolderItem; entry: DirEntry; path: string; onOpen: () => void }) {
  const { files } = useSession()
  const preview = usePreview()
  const ref = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<string | null>(null)
  const kind = kindOf(entry.name, entry.mime)
  const wantsThumb = entry.kind === 'file' && (kind === 'image' || kind === 'video')

  // lazily fetch thumbnails only for entries that scroll into view
  useEffect(() => {
    if (!wantsThumb || !ref.current) return
    let dead = false
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting)) {
        io.disconnect()
        void files.thumbURL(folder.owner, folder.key ?? '', 'dir', path).then((u) => !dead && setThumb(u))
      }
    })
    io.observe(ref.current)
    return () => {
      dead = true
      io.disconnect()
    }
  }, [wantsThumb, files, folder.owner, folder.key, path])

  const req = { op: 'file', kind: 'dir', key: folder.key ?? '', path, alias: folderAlias(folder.key ?? '', path, entry.size, entry.mtime) } as const
  const args = { ownerId: folder.owner, ownerName: folder.ownerName, req, name: entry.name, size: entry.size, mime: entry.mime }
  const open = useCallback(() => (entry.kind === 'dir' ? onOpen() : canPreview(entry.name, entry.mime, entry.size) ? preview(args) : void files.download(args)), [entry, onOpen, preview, files]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={s.child} ref={ref}>
      {entry.kind === 'dir' ? (
        <button className={s.folderBtn} style={{ background: folder.color }} onClick={onOpen}>
          <Icon name="folder" size={28} />
        </button>
      ) : (
        <div className={s.thumb} onClick={open} role="button" tabIndex={0}>
          {thumb ? <img src={thumb} alt="" /> : <TypeIcon name={entry.name} mime={entry.mime} size={44} />}
        </div>
      )}
      <div className={s.childName} title={entry.name}>{entry.name}</div>
      <div className={s.childSub}>{entry.kind === 'dir' ? 'Folder' : formatSize(entry.size)}</div>
      {entry.kind === 'file' && (
        <div className={s.childActions}>
          {canPreview(entry.name, entry.mime, entry.size) && (
            <button title="Preview" onClick={() => preview(args)}>
              <Icon name="eye" size={14} />
            </button>
          )}
          <button title="Download" onClick={() => void files.download(args)}>
            <Icon name="download" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
