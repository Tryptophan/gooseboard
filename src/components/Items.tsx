import { memo, useState, type CSSProperties } from 'react'
import { strokePath } from '../lib/stroke'
import { normalizeUrl } from '../lib/url'
import { relink } from '../model/actions'
import type { FolderItem, Item, LinkItem, StrokeItem } from '../model/types'
import { useSession, usePeers, useSourcesVersion } from '../state/session'
import { FileBody } from './FileCard'
import { Icon } from './Icons'
import { NoteBody } from './Note'
import s from './Items.module.css'

interface Props {
  item: Item
  selected: boolean
  dropTarget: boolean
  editing: boolean
  childCount: number
}

export const ItemView = memo(function ItemView({ item, selected, dropTarget, editing, childCount }: Props) {
  const style: CSSProperties = {
    transform: `translate(${item.x}px, ${item.y}px) rotate(${item.rot}rad)`,
    width: item.w,
    height: item.h,
  }
  return (
    <div
      className={`${s.item} ${selected ? s.selected : ''} ${dropTarget ? s.dropTarget : ''}`}
      data-item-id={item.id}
      data-type={item.type}
      style={style}
    >
      {item.type === 'note' && <NoteBody item={item} editing={editing} />}
      {item.type === 'stroke' && <StrokeBody item={item} />}
      {item.type === 'file' && <FileBody item={item} />}
      {item.type === 'folder' && <FolderBody item={item} childCount={childCount} />}
      {item.type === 'link' && <LinkBody item={item} editing={editing} />}
    </div>
  )
})

function StrokeBody({ item }: { item: StrokeItem }) {
  const hl = item.opacity < 1
  const d = strokePath(item.points, item.size, hl)
  return (
    <svg className={s.strokeSvg} viewBox={`0 0 ${item.ow} ${item.oh}`} preserveAspectRatio="none" width={item.w} height={item.h}>
      <path d={d} fill={item.color} opacity={item.opacity} style={hl ? { mixBlendMode: 'multiply' } : undefined} />
    </svg>
  )
}

function FolderBody({ item, childCount }: { item: FolderItem; childCount: number }) {
  const session = useSession()
  const { profile, sources } = session
  const { online } = usePeers()
  useSourcesVersion()
  const disk = item.mode === 'disk'
  const mine = item.owner === profile.id
  const unlinked = disk && mine && !!item.key && !sources.isReady(item.key)
  const status = !disk ? '' : mine ? (unlinked ? 'unlinked' : 'mine') : online.has(item.owner) ? 'online' : 'offline'
  return (
    <div className={s.folder}>
      <svg viewBox="0 0 120 92" preserveAspectRatio="none" className={s.folderSvg} aria-hidden>
        <path d="M6 14a8 8 0 018-8h26l10 10h56a8 8 0 018 8v54a8 8 0 01-8 8H14a8 8 0 01-8-8z" fill={item.color} />
        <path d="M6 30h108v48a8 8 0 01-8 8H14a8 8 0 01-8-8z" fill="#fff" opacity="0.22" />
      </svg>
      <div className={s.folderInfo}>
        <div className={s.cardName} title={item.name}>
          {disk && <Icon name="disk" size={13} />} {item.name}
        </div>
        <div className={s.cardMeta}>
          {disk ? (
            <>
              <span className={`${s.dot} ${s[status]}`} />
              <span>{mine ? 'on your disk' : `${item.ownerName}’s disk`}</span>
            </>
          ) : (
            <span>
              {childCount} item{childCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>
      {unlinked && (
        <button className={s.relink} data-nodrag title="Pick the folder again so others can browse it" onClick={() => void relink(session, item.key!, 'dir')}>
          <Icon name="refresh" size={14} /> Relink
        </button>
      )}
    </div>
  )
}

function LinkBody({ item, editing }: { item: LinkItem; editing: boolean }) {
  const { store } = useSession()
  const [draft, setDraft] = useState('')
  const [iconFailed, setIconFailed] = useState(false)
  const url = normalizeUrl(item.url)
  const host = url ? new URL(url).host : ''

  if (!item.url) {
    return (
      <div className={`${s.card} ${s.link}`}>
        <input
          data-nodrag
          autoFocus={editing}
          className={s.linkInput}
          placeholder="Paste a link and press Enter"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              const u = normalizeUrl(draft)
              if (u) store.update(item.id, { url: u })
            }
            if (e.key === 'Escape') store.remove([item.id])
          }}
        />
      </div>
    )
  }
  return (
    <div className={`${s.card} ${s.link}`}>
      <div className={s.favicon}>
        {url && !iconFailed ? (
          <img src={`${new URL(url).origin}/favicon.ico`} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setIconFailed(true)} draggable={false} />
        ) : (
          <Icon name="link" size={18} />
        )}
      </div>
      <div className={s.cardInfo}>
        <div className={s.cardName} title={item.url}>
          {item.title || host || 'Invalid link'}
        </div>
        <div className={s.cardMeta}>
          {url ? (
            <a data-nodrag href={url} target="_blank" rel="noopener noreferrer">
              {url.replace(/^https?:\/\//, '')}
            </a>
          ) : (
            <span>Blocked: not an http(s) link</span>
          )}
        </div>
      </div>
    </div>
  )
}
