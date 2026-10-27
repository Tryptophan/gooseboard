import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { formatSize, kindOf } from '../lib/files'
import type { GetReq, ReqState } from '../net/p2p'
import { canStream } from '../net/streamSW'
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

/** whole-file previews are held in memory; streamed media has no cap */
const MAX_PREVIEW = 200 * 1024 * 1024
const Ctx = createContext<(a: PreviewArgs) => void>(() => {})
export const usePreview = () => useContext(Ctx)

const isMedia = (k: string) => k === 'video' || k === 'audio'

export const canPreview = (name: string, mime: string, size: number) => {
  const k = kindOf(name, mime)
  if (isMedia(k) && canStream()) return true
  return size <= MAX_PREVIEW && (k === 'image' || isMedia(k) || k === 'pdf' || ((k === 'text' || k === 'code') && size <= 1_000_000))
}

const waitNote = (st: ReqState, owner: string) =>
  st === 'waiting-owner' ? `Waiting for ${owner} to come online…` : st === 'waiting-relink' ? `Waiting for ${owner} to relink the file…` : null

/** MEDIA_ERR_DECODE / MEDIA_ERR_SRC_NOT_SUPPORTED: the format, not the transfer, is the problem */
const unplayable = (e: MediaError | null) => e?.code === 3 || e?.code === 4

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
  const [stall, setStall] = useState<string | null>(null)
  const [cantPlay, setCantPlay] = useState(false)
  const urlRef = useRef<string | null>(null)
  const rangeErr = useRef<string | null>(null)
  const kind = kindOf(args.name, args.mime)
  const [streamed, setStreamed] = useState(() => isMedia(kind) && canStream())

  useEffect(() => {
    if (!streamed) return
    const st = files.stream(args.ownerId, args.req, args.size, args.mime, {
      onState: (x) => setStall(waitNote(x, args.ownerName)),
      onError: (m) => (rangeErr.current = m),
    })
    setUrl(st.url)
    return () => st.close()
  }, [files, args, streamed])

  useEffect(() => {
    if (streamed) return
    let dead = false
    // shared with the Download button, so downloading while (or after) previewing fetches once
    const lease = files.acquire(args.ownerId, args.req)
    const f = lease.fetch
    let frame = 0
    const watch = () => {
      setNote(waitNote(f.state, args.ownerName) ?? 'Downloading…')
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
  }, [files, args, kind, streamed])

  const onMediaError = (e: SyntheticEvent<HTMLMediaElement>) => {
    const me = e.currentTarget.error
    if (streamed && args.size <= MAX_PREVIEW) {
      // streaming failed: try the whole file, which the player gets as a plain blob
      rangeErr.current = null
      setStall(null)
      setUrl(null)
      setStreamed(false)
    } else if (rangeErr.current) setErr(rangeErr.current)
    else if (unplayable(me)) setCantPlay(true)
    else setErr(me?.message || 'playback failed')
  }

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
          ) : cantPlay ? (
            <p className={s.msg}>This browser can’t play this format. Download it to open it in another app.</p>
          ) : text !== null ? (
            <pre className={s.text}>{text}</pre>
          ) : url ? (
            kind === 'image' ? (
              <img src={url} alt={args.name} />
            ) : isMedia(kind) ? (
              <div className={s.media}>
                {kind === 'video' ? <video src={url} controls autoPlay onError={onMediaError} /> : <audio src={url} controls autoPlay onError={onMediaError} />}
                {stall && <span className={s.stall}>{stall}</span>}
              </div>
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
