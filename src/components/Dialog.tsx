import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import s from './Dialog.module.css'

/**
 * In-page replacements for window.confirm / prompt (and the "copy this link" fallback), as
 * promises. One <DialogHost /> at the app root renders whichever is open.
 */
type Req =
  | { kind: 'confirm'; title: string; message?: string; ok?: string; danger?: boolean; done: (v: boolean) => void }
  | { kind: 'prompt'; title: string; message?: string; value?: string; placeholder?: string; ok?: string; done: (v: string | null) => void }
  | { kind: 'copy'; title: string; message?: string; value: string; done: () => void }
  /** a link to share: as a QR code, and as text to copy (`copied`: already on the clipboard) */
  | { kind: 'share'; title: string; message?: string; value: string; copied: boolean; done: () => void }

let current: Req | null = null
const queue: Req[] = []
const ids = new WeakMap<Req, number>()
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function show(r: Req) {
  ids.set(r, ++seq)
  if (current) queue.push(r)
  else current = r
  emit()
}
function finish() {
  current = queue.shift() ?? null
  emit()
}

export function confirmDialog(o: { title: string; message?: string; ok?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((done) => show({ kind: 'confirm', ...o, done }))
}

/** Resolves to the trimmed text, or null if cancelled or left empty. */
export function promptDialog(o: { title: string; message?: string; value?: string; placeholder?: string; ok?: string }): Promise<string | null> {
  return new Promise((done) => show({ kind: 'prompt', ...o, done }))
}

/** For when the clipboard API is refused: shows the text selected, with a copy button. */
export function copyDialog(title: string, value: string, message?: string): Promise<void> {
  return new Promise((done) => show({ kind: 'copy', title, value, message, done }))
}

/** Shows `url` as a QR code and as a link with a copy button; `copied` says it's on the clipboard already. */
export function shareDialog(title: string, url: string, copied: boolean, message?: string): Promise<void> {
  return new Promise((done) => show({ kind: 'share', title, value: url, copied, message, done }))
}

/** `text` as a QR code: dark squares on white, with the quiet margin scanners need, whatever the theme. */
function QrCode({ text }: { text: string }) {
  const { d, n } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`
    return { d, n: n + 8 }
  }, [text])
  return (
    <svg className={s.qr} viewBox={`0 0 ${n} ${n}`} role="img" aria-label="QR code of the link" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export function DialogHost() {
  const req = useSyncExternalStore(subscribe, () => current)
  return req ? <DialogBox key={ids.get(req)} req={req} /> : null
}

function DialogBox({ req }: { req: Req }) {
  const [text, setText] = useState(req.kind === 'confirm' ? '' : (req.value ?? ''))
  const [copied, setCopied] = useState(req.kind === 'share' && req.copied)
  const inputRef = useRef<HTMLInputElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    } else okRef.current?.focus()
  }, [])

  const close = (ok: boolean) => {
    if (req.kind === 'confirm') req.done(ok)
    else if (req.kind === 'prompt') req.done(ok && text.trim() ? text.trim() : null)
    else req.done()
    finish()
  }

  const copy = async () => {
    inputRef.current?.select()
    try {
      await navigator.clipboard.writeText(req.kind === 'copy' || req.kind === 'share' ? req.value : '')
      setCopied(true)
    } catch {
      // selected above: the person can still press Ctrl+C
      setCopied(document.execCommand?.('copy') ?? false)
    }
  }

  return (
    <div
      className={s.backdrop}
      data-nodrag
      onPointerDown={(e) => e.target === e.currentTarget && close(false)}
      // keep board shortcuts (Delete, Escape, tools...) from firing underneath
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') close(false)
      }}
    >
      <form
        className={s.box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onSubmit={(e) => {
          e.preventDefault()
          if (req.kind === 'copy' || req.kind === 'share') void copy()
          else close(true)
        }}
      >
        <b id="dialog-title">{req.title}</b>
        {req.kind === 'share' && <QrCode text={req.value} />}
        {req.message && <p>{req.message}</p>}
        {req.kind !== 'confirm' && (
          <input ref={inputRef} value={text} readOnly={req.kind === 'copy' || req.kind === 'share'} placeholder={req.kind === 'prompt' ? req.placeholder : undefined} onChange={(e) => setText(e.target.value)} />
        )}
        <div className={s.buttons}>
          {req.kind === 'share' && <span className={s.status}>{copied ? 'Link copied to the clipboard' : ''}</span>}
          <button type="button" onClick={() => close(false)}>
            {req.kind === 'copy' || req.kind === 'share' ? 'Close' : 'Cancel'}
          </button>
          <button
            ref={okRef}
            type="submit"
            className={req.kind === 'confirm' && req.danger ? s.danger : s.primary}
            disabled={req.kind === 'prompt' && !text.trim()}
          >
            {req.kind === 'copy' || req.kind === 'share' ? (copied ? 'Copied!' : 'Copy') : (req.ok ?? 'OK')}
          </button>
        </div>
      </form>
    </div>
  )
}
