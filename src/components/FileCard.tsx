import { formatSize, kindOf } from '../lib/files'
import type { FileItem } from '../model/types'
import { relink } from '../model/actions'
import { useSession, usePeers, useSourcesVersion } from '../state/session'
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
  const preview = usePreview()
  const mine = item.owner === profile.id
  const unlinked = mine && !sources.isReady(item.key)
  const status = mine ? (unlinked ? 'unlinked' : 'mine') : online.has(item.owner) ? 'online' : 'offline'
  const kind = kindOf(item.name, item.mime)
  const thumb = safeThumb(item.thumb)
  const req = { op: 'file', kind: 'file', key: item.key } as const
  const args = { ownerId: item.owner, ownerName: item.ownerName, req, name: item.name, size: item.size, mime: item.mime }

  return (
    <div className={`${s.card} ${s.file}`}>
      <div className={s.thumb}>
        {thumb ? <img src={thumb} alt="" draggable={false} /> : <TypeIcon name={item.name} mime={item.mime} />}
        {kind === 'video' && thumb && <span className={s.play}>▶</span>}
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
