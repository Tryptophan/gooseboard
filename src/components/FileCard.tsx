import { formatSize, kindOf } from '../lib/files'
import type { FileItem } from '../model/types'
import { relink } from '../model/actions'
import type { SyncState } from '../net/sync'
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
  const sync = useFileSync().stateOf(item)
  const preview = usePreview()
  const mine = item.owner === profile.id
  // a cached copy of my own small file still serves after a reload, so no relink is needed
  const unlinked = mine && !sources.isReady(item.key) && sync.status !== 'synced'
  const status = mine ? (unlinked ? 'unlinked' : 'mine') : online.has(item.owner) ? 'online' : 'offline'
  const kind = kindOf(item.name, item.mime)
  const thumb = safeThumb(item.thumb)
  const req = { op: 'file', kind: 'file', key: item.key, hash: item.hash } as const
  const args = { ownerId: item.owner, ownerName: item.ownerName, req, name: item.name, size: item.size, mime: item.mime }

  return (
    <div className={`${s.card} ${s.file}`}>
      <div className={s.thumb}>
        {thumb ? <img src={thumb} alt="" draggable={false} /> : <TypeIcon name={item.name} mime={item.mime} />}
        {kind === 'video' && thumb && <span className={s.play}>▶</span>}
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
      <div className={s.actions} data-nodrag>
        {unlinked && (
          <button title="Re-select this file so others can fetch it" onClick={() => void relink(session, item.key, 'file', item.name)}>
            <Icon name="refresh" size={15} />
          </button>
        )}
        {canPreview(item.name, item.mime, item.size) && (
          <button title="Preview" onClick={() => preview(args)}>
            <Icon name="eye" size={15} />
          </button>
        )}
        <button title="Download" onClick={() => void files.download(args)}>
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

function SyncBadge({ st, mine }: { st: SyncState; mine: boolean }) {
  const holders = `${st.holders} ${st.holders === 1 ? 'peer' : 'peers'} online with a copy`
  // just the status glyph (no percentage or holder count): a circle rather than a pill
  const solo = st.status !== 'syncing' && st.holders === 0
  const label = st.status === 'syncing' ? `Syncing ${Math.round((st.pct ?? 0) * 100)}%` : SYNC_LABEL[st.status]
  return (
    <span className={`${s.sync} ${s[st.status]} ${solo ? s.solo : ''}`} title={`${mine && st.status === 'synced' ? 'Shared from your disk' : label} · ${holders}`}>
      {st.status === 'syncing' ? `${Math.round((st.pct ?? 0) * 100)}%` : st.status === 'synced' ? '✓' : st.status === 'unsynced' ? '☁' : '!'}
      {st.holders > 0 && <b>{st.holders}</b>}
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
