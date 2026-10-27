import { useEffect, useRef, useState } from 'react'
import { formatSize } from '../lib/files'
import { relink } from '../model/actions'
import type { Transfer } from '../net/transfers'
import { usePendingRelinks, useSession, useTransfers } from '../state/session'
import { Icon } from './Icons'
import s from './Chrome.module.css'
import d from './Dialog.module.css'

const LABEL: Record<string, string> = {
  connecting: 'Connecting…',
  active: '',
  'waiting-owner': 'Waiting for owner to come online…',
  'waiting-relink': 'Owner needs to relink the file…',
  done: 'Done',
  error: 'Failed',
  canceled: 'Canceled',
}

const SHORT: Record<string, string> = {
  connecting: 'Connecting…',
  'waiting-owner': 'Waiting…',
  'waiting-relink': 'Waiting…',
}

/** How long the "all done" summary stays up before collapsing to the button. */
const LINGER_MS = 4000

const isFinished = (t: Transfer) => t.state === 'done' || t.state === 'error' || t.state === 'canceled'

/**
 * One-row summary above the zoom controls while anything is moving; collapses to a small
 * button once idle. Either opens the full list of current and past transfers.
 */
export function TransferPanel() {
  const list = useTransfers()
  const [modal, setModal] = useState(false)
  const [lingering, setLingering] = useState(false)
  const live = list.filter((t) => !isFinished(t))
  const busy = live.length > 0

  // Show the finished summary for a moment after the last transfer ends.
  // Failures are counted only for the batch that just ended, not the whole history.
  const wasBusy = useRef(false)
  const batchStart = useRef(0)
  const liveRef = useRef(live)
  liveRef.current = live
  useEffect(() => {
    if (busy) {
      wasBusy.current = true
      batchStart.current = Math.min(...liveRef.current.map((t) => t.startedAt))
      setLingering(false)
      return
    }
    if (!wasBusy.current) return
    wasBusy.current = false
    setLingering(true)
    const t = setTimeout(() => setLingering(false), LINGER_MS)
    return () => clearTimeout(t)
  }, [busy])

  if (!list.length && !modal) return null

  let row = null
  if (busy) {
    const size = live.reduce((n, t) => n + t.size, 0)
    const done = live.reduce((n, t) => n + Math.min(t.done, t.size), 0)
    const pct = size ? Math.min(100, (done / size) * 100) : 0
    const first = live[live.length - 1]
    const dirs = new Set(live.map((t) => t.dir))
    const label = live.length === 1 ? first.name : `${first.name} +${live.length - 1} more`
    const status = live.length === 1 ? (SHORT[first.state] ?? `${Math.round(pct)}%`) : `${Math.round(pct)}%`
    row = (
      <div className={s.tNotice} data-nodrag>
        <button className={`${s.tNoticeMain} ${s.tNoticeTop}`} title="Show all transfers" onClick={() => setModal(true)}>
          <Icon name={dirs.size > 1 ? 'transfers' : first.dir === 'down' ? 'download' : 'up'} size={14} />
          <span className={s.tName}>{label}</span>
          <span className={s.tPct}>{status}</span>
          <Icon name="expand" size={13} />
        </button>
        <div className={s.bar}>
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  } else if (lingering) {
    const failed = list.filter((t) => t.state === 'error' && t.startedAt >= batchStart.current).length
    row = (
      <div className={s.tNotice} data-nodrag>
        <div className={s.tNoticeTop}>
          <button className={s.tNoticeMain} title="Show all transfers" onClick={() => setModal(true)}>
            <Icon name={failed ? 'close' : 'check'} size={14} />
            <span className={s.tName}>{failed ? `${failed} transfer${failed > 1 ? 's' : ''} failed` : 'Transfers complete'}</span>
            <Icon name="expand" size={13} />
          </button>
          <button className={s.tIconBtn} title="Hide" onClick={() => setLingering(false)}>
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>
    )
  } else if (list.length) {
    row = (
      <button className={s.tButton} data-nodrag title={`Transfers (${list.length})`} onClick={() => setModal(true)}>
        <Icon name="transfers" size={16} />
      </button>
    )
  }

  return (
    <>
      {row}
      {modal && <TransferModal list={list} onClose={() => setModal(false)} />}
    </>
  )
}

function TransferModal({ list, onClose }: { list: Transfer[]; onClose: () => void }) {
  const { transfers } = useSession()
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => closeRef.current?.focus(), [])
  const newest = [...list].reverse()
  const anyFinished = list.some(isFinished)
  return (
    <div
      className={d.backdrop}
      data-nodrag
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      // keep board shortcuts from firing underneath
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className={`${d.box} ${s.tModal}`} role="dialog" aria-modal="true" aria-labelledby="transfers-title">
        <div className={s.transfersHead}>
          <b id="transfers-title">Transfers</b>
          <span>
            <button disabled={!anyFinished} onClick={() => transfers.clearFinished()}>
              Clear finished
            </button>
            <button ref={closeRef} title="Close" onClick={onClose}>
              <Icon name="close" size={14} />
            </button>
          </span>
        </div>
        <div className={s.tList}>
          {newest.length ? newest.map((t) => <TransferRow key={t.id} t={t} />) : <p>No transfers yet.</p>}
        </div>
      </div>
    </div>
  )
}

function TransferRow({ t }: { t: Transfer }) {
  const { transfers } = useSession()
  const pct = t.size ? Math.min(100, (t.done / t.size) * 100) : 0
  const finished = isFinished(t)
  return (
    <div className={s.transfer}>
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
