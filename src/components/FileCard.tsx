import { useEffect } from 'react'
import { formatSize, kindOf } from '../lib/files'
import { getAutoSyncMax } from '../lib/autoSync'
import { mediaBox } from '../lib/media'
import type { FileItem } from '../model/types'
import { relink } from '../model/actions'
import type { SyncState } from '../net/sync'
import { thumbSize } from '../net/thumbs'
import { useFileSync, useSession, usePeers, useSourcesVersion } from '../state/session'
import { Icon } from './Icons'
import { canPreview, usePreview } from './Preview'
import { TypeIcon } from './TypeIcon'
import s from './Items.module.css'

export const safeThumb = (t?: string) => (t && t.startsWith('data:image/') ? t : undefined)

export function FileBody({ item }: { item: FileItem }) {
  const session = useSession()
  const { files, profile, sources } = session
  const { online } = usePeers()
  useSourcesVersion()
  const fileSync = useFileSync()
  const sync = fileSync.stateOf(item)
  // small files sync on their own; bigger ones on request
  const canSync = item.size > getAutoSyncMax() && fileSync.canSync(item)
  const preview = usePreview()
  const mine = item.owner === profile.id
  // a cached copy of my own small file still serves after a reload, so no relink is needed
  const unlinked = mine && !sources.isReady(item.key) && sync.status !== 'synced'
  // nobody online can serve it: opening or downloading would only wait
  const blocked = unlinked || (!mine && sync.status === 'unavailable')
  const why = unlinked ? 'Re-select the file first' : `${item.ownerName} is offline and nobody online has a copy`
  const status = mine ? (unlinked ? 'unlinked' : 'mine') : online.has(item.owner) ? 'online' : 'offline'
  const kind = kindOf(item.name, item.mime)
  const thumb = safeThumb(item.thumb)
  const req = { op: 'file', kind: 'file', key: item.key, hash: item.hash } as const
  const args = { ownerId: item.owner, ownerName: item.ownerName, req, name: item.name, size: item.size, mime: item.mime }

  // pictures and videos added before sizes were recorded: take the aspect from the thumbnail and show them bare
  useEffect(() => {
    if ((kind !== 'image' && kind !== 'video') || !thumb) return
    let dead = false
    void thumbSize(thumb).then((d) => {
      const it = !dead && d && session.store.getSnapshot().all.get(item.id)
      if (!d || !it || it.type !== 'file' || it.iw) return
      const { w, h } = mediaBox(d.w, d.h)
      session.store.updateSilent(it.id, { iw: d.w, ih: d.h, w, h, x: Math.round(it.x + it.w / 2 - w / 2), y: Math.round(it.y + it.h / 2 - h / 2) })
    })
    return () => {
      dead = true
    }
  }, [session, item.id, kind, thumb])

  return (
    <div className={`${s.card} ${s.file} ${blocked ? s.pinned : ''}`}>
      <div className={s.thumb}>
        {thumb ? <img src={thumb} alt="" draggable={false} /> : <TypeIcon name={item.name} mime={item.mime} />}
        {/* a drawn triangle: the ▶ glyph sits off-centre and turns into an emoji on some platforms */}
        {kind === 'video' && thumb && (
          <span className={s.play}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M9 6v12l10-6z" />
            </svg>
          </span>
        )}
        <SyncBadge st={sync} mine={mine} />
      </div>
      <div className={s.cardInfo}>
        <div className={s.cardName} title={item.name}>
          {item.name}
        </div>
        <div className={s.cardMeta}>
          <span>{formatSize(item.size)}</span>
          <span className={`${s.dot} ${s[status]}`} title={statusTitle(status, item.ownerName)} />
          <span className={s.owner}>{mine ? 'you' : item.ownerName}</span>
        </div>
      </div>
      {/* while the file can't be had (re-select it, or nobody online has it), the buttons stay up, greyed out */}
      <div className={`${s.actions} ${blocked ? s.actionsOn : ''}`} data-nodrag>
        {unlinked && (
          <button className={s.warn} title="Re-select this file: this browser lost access to it" onClick={() => void relink(session, item.key, 'file', item.name)}>
            <Icon name="refresh" size={15} />
          </button>
        )}
        {canSync && (
          <button title="Sync: keep a copy in this browser, so it opens instantly and you can share it on" onClick={() => fileSync.syncNow(item)}>
            <Icon name="cloudDown" size={15} />
          </button>
        )}
        {canPreview(item.name, item.mime, item.size) && (
          <button title={blocked ? why : 'Preview'} aria-disabled={blocked} onClick={() => !blocked && preview(args)}>
            <Icon name="eye" size={15} />
          </button>
        )}
        <button title={blocked ? why : 'Download'} aria-disabled={blocked} onClick={() => !blocked && void files.download(args)}>
          <Icon name="download" size={15} />
        </button>
      </div>
    </div>
  )
}

const SYNC_LABEL: Record<SyncState['status'], string> = {
  synced: 'Synced: a copy is on this device',
  syncing: 'Syncing',
  unsynced: 'Not synced: fetched when you open or download it',
  unavailable: 'Unavailable: nobody online has a copy',
}

/** Sync status and how many peers online hold a copy; shown on hover. */
export function SyncBadge({ st, mine }: { st: SyncState; mine: boolean }) {
  const holders = `${st.holders} ${st.holders === 1 ? 'peer' : 'peers'} online with a copy`
  // just the status glyph (no percentage or holder count): a circle rather than a pill
  const solo = st.status !== 'syncing' && st.holders === 0
  const label = st.status === 'syncing' ? `Syncing ${Math.round((st.pct ?? 0) * 100)}%` : SYNC_LABEL[st.status]
  return (
    <span className={`${s.sync} ${s[st.status]} ${solo ? s.solo : ''}`} title={`${mine && st.status === 'synced' ? 'Shared from your disk' : label} · ${holders}`}>
      {st.status === 'syncing' ? `${Math.round((st.pct ?? 0) * 100)}%` : st.status === 'synced' ? '✓' : st.status === 'unsynced' ? '☁' : '!'}
      {st.holders > 0 && <b>{st.holders > 9 ? '9+' : st.holders}</b>}
    </span>
  )
}

function statusTitle(st: string, owner: string) {
  switch (st) {
    case 'mine':
      return 'Served from your disk'
    case 'unlinked':
      return 'Needs relinking: pick the file again'
    case 'online':
      return `${owner} is online`
    default:
      return `${owner} is offline: can’t fetch until they return`
  }
}
