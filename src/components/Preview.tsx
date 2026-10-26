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
  const urlRef = useRef<string | null>(null)
  const kind = kindOf(args.name, args.mime)

  useEffect(() => {
    let dead = false
    files
      .getBlob(args.ownerId, { ...args.req, op: 'file' }, (st) =>
        setNote(st === 'waiting-owner' ? `Waiting for ${args.ownerName} to come online…` : st === 'waiting-relink' ? `Waiting for ${args.ownerName} to relink the file…` : 'Downloading…'),
      )
      .then(async (b) => {
        if (dead) return
        if (kind === 'text' || kind === 'code') setText(await b.text())
        else {
          urlRef.current = URL.createObjectURL(b)
          setUrl(urlRef.current)
        }
      })
      .catch((e) => !dead && setErr((e as Error).message))
    return () => {
      dead = true
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
            ) : (
              <iframe src={url} title={args.name} sandbox="" />
            )
          ) : (
            <p className={s.msg}>{note}</p>
          )}
        </div>
      </div>
    </div>
  )
}
