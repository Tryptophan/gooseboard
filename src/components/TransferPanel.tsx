import { useState } from 'react'
import { formatSize } from '../lib/files'
import { relink } from '../model/actions'
import { usePendingRelinks, useSession, useTransfers } from '../state/session'
import { Icon } from './Icons'
import s from './Chrome.module.css'

const LABEL: Record<string, string> = {
  connecting: 'Connecting…',
  active: '',
  'waiting-owner': 'Waiting for owner to come online…',
  'waiting-relink': 'Owner needs to relink the file…',
  done: 'Done',
  error: 'Failed',
  canceled: 'Canceled',
}

export function TransferPanel() {
  const { transfers } = useSession()
  const list = useTransfers()
  const [open, setOpen] = useState(true)
  if (!list.length) return null
  const live = list.filter((t) => t.state !== 'done' && t.state !== 'error' && t.state !== 'canceled').length
  return (
    <div className={s.transfers} data-nodrag>
      <div className={s.transfersHead}>
        <button onClick={() => setOpen(!open)}>
          Transfers{live ? ` (${live} active)` : ''}
        </button>
        <button title="Clear finished" onClick={() => transfers.clearFinished()}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {open &&
        list.map((t) => {
          const pct = t.size ? Math.min(100, (t.done / t.size) * 100) : 0
          const finished = t.state === 'done' || t.state === 'error' || t.state === 'canceled'
          return (
            <div key={t.id} className={s.transfer}>
              <div className={s.transferTop}>
                <Icon name={t.dir === 'down' ? 'download' : 'up'} size={14} />
                <span className={s.tName} title={t.name}>
                  {t.name}
                </span>
                <button title={finished ? 'Dismiss' : 'Cancel'} onClick={() => (finished ? transfers.remove(t.id) : t.cancel?.())}>
                  <Icon name="close" size={13} />
                </button>
              </div>
              <div className={s.bar}>
                <i style={{ width: `${t.state === 'done' ? 100 : pct}%` }} />
              </div>
              <div className={s.tMeta}>
                {t.dir === 'down' ? 'from' : 'to'} {t.peerName} · {formatSize(t.done)} / {formatSize(t.size)}
                {LABEL[t.state] ? ` · ${t.error ?? LABEL[t.state]}` : ''}
              </div>
            </div>
          )
        })}
    </div>
  )
}

/** Owner-side prompt: someone asked for a file this browser can no longer read. */
export function RelinkBanner() {
  const session = useSession()
  const pending = usePendingRelinks()
  if (!pending.length) return null
  return (
    <div className={s.relinkBanner} data-nodrag>
      {pending.map((p) => (
        <div key={p.key} className={s.relinkRow}>
          <Icon name="lock" size={16} />
          <span>
            <b>{p.askedBy.join(', ')}</b> {p.askedBy.length > 1 ? 'are' : 'is'} waiting for <b>{p.name}</b>. Pick the {p.kind === 'file' ? 'file' : 'folder'} again to share it.
          </span>
          <button className={s.primary} onClick={() => void relink(session, p.key, p.kind, p.kind === 'file' ? p.name : undefined)}>
            Relink
          </button>
          <button onClick={() => session.p2p.dismissPending(p.key)}>Dismiss</button>
        </div>
      ))}
    </div>
  )
}
