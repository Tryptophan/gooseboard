import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { formatSize, kindOf } from '../lib/files'
import type { GetReq } from '../net/p2p'
import { useSession } from '../state/session'
import { Icon } from './Icons'
import s from './Preview.module.css'

export interface PreviewArgs {
  ownerId: string
  ownerName: string
  req: GetReq
  name: string
  size: number
  mime: string
}

const MAX_PREVIEW = 200 * 1024 * 1024
const Ctx = createContext<(a: PreviewArgs) => void>(() => {})
export const usePreview = () => useContext(Ctx)

export const canPreview = (name: string, mime: string, size: number) => {
  const k = kindOf(name, mime)
  return size <= MAX_PREVIEW && (k === 'image' || k === 'video' || k === 'audio' || k === 'pdf' || ((k === 'text' || k === 'code') && size <= 1_000_000))
}

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [args, setArgs] = useState<PreviewArgs | null>(null)
  const open = useCallback((a: PreviewArgs) => setArgs(a), [])
  return (
    <Ctx.Provider value={open}>
      {children}
      {args && <PreviewModal args={args} onClose={() => setArgs(null)} />}
    </Ctx.Provider>
  )
}

function PreviewModal({ args, onClose }: { args: PreviewArgs; onClose: () => void }) {
  const { files, profile } = useSession()
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState('Fetching from ' + (args.ownerId === profile.id ? 'disk' : args.ownerName) + '…')
  const [done, setDone] = useState<number | null>(null)
  const urlRef = useRef<string | null>(null)
  const kind = kindOf(args.name, args.mime)

  useEffect(() => {
    let dead = false
    // shared with the Download button, so downloading while (or after) previewing fetches once
    const lease = files.acquire(args.ownerId, args.req)
    const f = lease.fetch
    let frame = 0
    const watch = () => {
      const st = f.state
      setNote(st === 'waiting-owner' ? `Waiting for ${args.ownerName} to come online…` : st === 'waiting-relink' ? `Waiting for ${args.ownerName} to relink the file…` : 'Downloading…')
      // progress arrives per chunk: repaint at most once a frame
      frame ||= requestAnimationFrame(() => {
        frame = 0
        setDone(f.state === 'active' || f.done > 0 ? f.done : null)
      })
    }
    f.watchers.add(watch)
    watch()
    f.result
      .then(async ({ blob: b }) => {
        if (dead) return
        if (kind === 'text' || kind === 'code') setText(await b.text())
        else {
          // the peer's mime is untrusted: pin PDFs to the browser's viewer so nothing else renders in our origin
          urlRef.current = URL.createObjectURL(kind === 'pdf' ? new Blob([b], { type: 'application/pdf' }) : b)
          setUrl(urlRef.current)
        }
      })
      .catch((e) => !dead && setErr((e as Error).message))
    return () => {
      dead = true
      f.watchers.delete(watch)
      cancelAnimationFrame(frame)
      lease.release()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [files, args, kind])

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div className={s.box} onClick={(e) => e.stopPropagation()}>
        <div className={s.head}>
          <b>{args.name}</b>
          <span>{formatSize(args.size)}</span>
          <button onClick={() => void files.download({ ownerId: args.ownerId, ownerName: args.ownerName, req: args.req, name: args.name, size: args.size })}>
            <Icon name="download" size={16} /> Download
          </button>
          <button onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className={s.body}>
          {err ? (
            <p className={s.msg}>Couldn’t load: {err}</p>
          ) : text !== null ? (
            <pre className={s.text}>{text}</pre>
          ) : url ? (
            kind === 'image' ? (
              <img src={url} alt={args.name} />
            ) : kind === 'video' ? (
              <video src={url} controls autoPlay />
            ) : kind === 'audio' ? (
              <audio src={url} controls autoPlay />
            ) : kind === 'pdf' ? (
              // no sandbox: Chrome blocks and Firefox blanks their PDF viewers inside one
              <iframe src={url} title={args.name} />
            ) : null
          ) : done !== null ? (
            <Progress done={done} size={args.size} note={note === 'Downloading…' ? null : note} />
          ) : (
            <p className={s.msg}>{note}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function Progress({ done, size, note }: { done: number; size: number; note: string | null }) {
  const pct = size > 0 ? Math.min(100, (done / size) * 100) : 0
  return (
    <div className={s.progress}>
      <div className={s.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <span>
        {formatSize(done)} of {formatSize(size)} · {Math.floor(pct)}%
      </span>
      {note && <span>{note}</span>}
    </div>
  )
}
