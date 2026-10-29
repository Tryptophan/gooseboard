import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useBackLayer } from '../lib/back'
import { exportName, exportSize, ExportAssets, planExport, renderBoard, saveFile, toPng } from '../lib/exportImage'
import { toast } from '../lib/toast'
import { useSession } from '../state/session'
import d from './Dialog.module.css'
import s from './ExportDialog.module.css'

/** "Export as image": the whole board as a PNG, with a preview, a scale, and padding. */
let open = false
const listeners = new Set<() => void>()
const set = (v: boolean) => {
  open = v
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export const openExport = () => set(true)

export function ExportHost() {
  const isOpen = useSyncExternalStore(subscribe, () => open)
  // closed when the board is left
  useEffect(() => () => set(false), [])
  return isOpen ? <ExportDialog onClose={() => set(false)} /> : null
}

const SCALES = [1, 2, 3]
const PADDINGS = [0, 24, 48, 96]
/** the preview's box, in CSS px */
const PREVIEW_W = 380
const PREVIEW_H = 240

const canCopy = () => typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write

function ExportDialog({ onClose }: { onClose: () => void }) {
  const session = useSession()
  useBackLayer(true, onClose)
  // the board as it was when the dialog opened
  const plan = useMemo(() => planExport(session), [session])
  const assets = useMemo(() => new ExportAssets(session), [session])
  useEffect(() => () => assets.dispose(), [assets])
  const [scale, setScale] = useState(2)
  const [padding, setPadding] = useState(48)
  const [busy, setBusy] = useState<'save' | 'copy' | null>(null)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const preview = useRef<HTMLCanvasElement>(null)
  const size = plan && exportSize(plan, padding, scale)

  useEffect(() => {
    if (!plan) return
    let dead = false
    const full = exportSize(plan, padding, 1)
    const fitK = Math.min(PREVIEW_W / full.w, PREVIEW_H / full.h, 1)
    const k = fitK * (window.devicePixelRatio || 1)
    void renderBoard(plan, assets, { scale: k, padding })
      .then((c) => {
        const el = preview.current
        if (dead || !el) return
        el.width = c.width
        el.height = c.height
        // height follows from the aspect (the CSS keeps it within the dialog)
        el.style.width = `${c.width / (window.devicePixelRatio || 1)}px`
        el.getContext('2d')!.drawImage(c, 0, 0)
      })
      .catch((e: Error) => !dead && setErr(e.message))
    return () => {
      dead = true
    }
  }, [plan, assets, padding])

  const render = () => renderBoard(plan!, assets, { scale: size!.scale, padding }).then(toPng)

  const save = async () => {
    setBusy('save')
    setErr(null)
    try {
      saveFile(await render(), exportName(session.store.name))
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const copy = async () => {
    setBusy('copy')
    setErr(null)
    try {
      // handed over as a promise, inside the click: Safari only allows the write then
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': render() })])
      setCopied(true)
      toast('Board image copied')
    } catch (e) {
      setErr((e as Error).name === 'NotAllowedError' ? 'The browser didn’t allow copying the image' : (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

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
      <div className={`${d.box} ${s.box}`} role="dialog" aria-modal="true" aria-labelledby="export-title">
        <b id="export-title">Export as image</b>
        {!plan ? (
          <p>Nothing on the board to export yet.</p>
        ) : (
          <>
            <div className={s.preview}>
              <canvas ref={preview} aria-label="Preview of the image" role="img" />
            </div>
            <div className={s.row}>
              <span className={s.label}>Scale</span>
              <div className={s.seg} role="radiogroup" aria-label="Scale">
                {SCALES.map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={scale === k} className={scale === k ? s.on : ''} onClick={() => setScale(k)}>
                    {k}×
                  </button>
                ))}
              </div>
            </div>
            <div className={s.row}>
              <span className={s.label}>Padding</span>
              <div className={s.seg} role="radiogroup" aria-label="Padding">
                {PADDINGS.map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={padding === p} className={padding === p ? s.on : ''} onClick={() => setPadding(p)}>
                    {p === 0 ? 'None' : p}
                  </button>
                ))}
              </div>
            </div>
            <p>
              {size!.w.toLocaleString()} × {size!.h.toLocaleString()} px, PNG
              {size!.capped && ', scaled down to fit what the browser can draw'}
            </p>
          </>
        )}
        {err && <p className={s.err}>{err}</p>}
        <div className={d.buttons}>
          <button type="button" onClick={onClose}>
            {plan ? 'Cancel' : 'Close'}
          </button>
          {plan && canCopy() && (
            <button type="button" disabled={!!busy} onClick={() => void copy()}>
              {busy === 'copy' ? 'Copying…' : copied ? 'Copied!' : 'Copy'}
            </button>
          )}
          {plan && (
            <button type="button" className={d.primary} disabled={!!busy} autoFocus onClick={() => void save()}>
              {busy === 'save' ? 'Drawing…' : 'Download'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
