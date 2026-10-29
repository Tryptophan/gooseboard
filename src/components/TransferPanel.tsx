import { useEffect } from 'react'
import { formatSize } from '../lib/files'
import { relink } from '../model/actions'
import type { Transfer } from '../net/transfers'
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
  interrupted: 'Interrupted',
}

const isFinished = (t: Transfer) => t.state === 'done' || t.state === 'error' || t.state === 'canceled'
/** not moving: finished, or stopped and waiting for Resume */
const isIdle = (t: Transfer) => isFinished(t) || t.state === 'interrupted'

/** What's moving right now, for the badge on Goosey: count and overall 0..1 progress. */
export function useTransferProgress() {
  const live = useTransfers().filter((t) => !isIdle(t))
  const size = live.reduce((n, t) => n + t.size, 0)
  const done = live.reduce((n, t) => n + Math.min(t.done, t.size), 0)
  return { count: live.length, pct: size ? Math.min(1, done / size) : 0 }
}

/** While files are moving, closing or reloading the tab asks first (it would cut them off). */
export function useLeaveGuard() {
  const { count } = useTransferProgress()
  useEffect(() => {
    if (!count) return
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [count])
}

/** Goosey's Transfers tab: current and past transfers, newest first. */
export function TransfersTab() {
  const { transfers } = useSession()
  const list = useTransfers()
  const newest = [...list].reverse()
  return (
    <>
      <div className={s.transfersHead}>
        <span className={s.tSummary}>{list.length ? `${list.filter((t) => !isIdle(t)).length} moving · ${list.length} in all` : ''}</span>
        <span>
          <button disabled={!list.some(isFinished)} onClick={() => transfers.clearFinished()}>
            Clear finished
          </button>
        </span>
      </div>
      <div className={s.tList}>{newest.length ? newest.map((t) => <TransferRow key={t.id} t={t} />) : <p>No transfers yet. Files people open or download from each other show up here.</p>}</div>
    </>
  )
}

function TransferRow({ t }: { t: Transfer }) {
  const { transfers } = useSession()
  const pct = t.size ? Math.min(100, (t.done / t.size) * 100) : 0
  const idle = isIdle(t)
  // dismissing a transfer that could resume also forgets it was wanted
  const close = () => (idle ? (t.resume && t.cancel?.(), transfers.remove(t.id)) : t.cancel?.())
  return (
    <div className={s.transfer}>
      <div className={s.transferTop}>
        <Icon name={t.dir === 'down' ? 'download' : 'up'} size={14} />
        <span className={s.tName} title={t.name}>
          {t.name}
        </span>
        {t.resume && idle && (
          <button className={s.tResume} onClick={t.resume}>
            Resume
          </button>
        )}
        <button title={idle ? 'Dismiss' : 'Cancel'} onClick={close}>
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
