import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { leaveLayers, useBackLayer } from '../lib/back'
import { touchBoard } from '../lib/storage'
import { QrLink, type BoardRef, type LinkState } from '../net/qrlink'
import { QrCode } from './Dialog'
import { Icon } from './Icons'
import d from './Dialog.module.css'
import s from './QrLink.module.css'

type Decode = (img: ImageData, thorough: boolean) => Uint8Array | null

/** jsQR, loaded on first use. It hands back the raw bytes; BarcodeDetector only gives text, which mangles QWBP's binary codes. */
let decoder: Promise<Decode> | null = null
const loadDecoder = () =>
  (decoder ??= import('jsqr').then(({ default: jsQR }) => (img: ImageData, thorough: boolean) => {
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: thorough ? 'attemptBoth' : 'dontInvert' })
    return r?.binaryData.length ? new Uint8Array(r.binaryData) : null
  }))

/** Pixels of `src`, scaled so the longer side is at most `max`. */
function pixels(src: CanvasImageSource, w: number, h: number, max: number, canvas = document.createElement('canvas')) {
  const k = Math.min(1, max / Math.max(w, h))
  canvas.width = Math.round(w * k)
  canvas.height = Math.round(h * k)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height)
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

/** Reads QR codes from the camera while `on`; `err` when there's no camera or it was refused. */
function useScanner(on: boolean, onCode: (b: Uint8Array) => void) {
  const video = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState(false)
  const cb = useRef(onCode)
  cb.current = onCode
  useEffect(() => {
    if (!on) return
    let stop = false
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const canvas = document.createElement('canvas')
    void (async () => {
      try {
        const decode = await loadDecoder()
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        if (stop) return stream.getTracks().forEach((t) => t.stop())
        const v = video.current!
        v.srcObject = stream
        await v.play().catch(() => {})
        setErr(false)
        const tick = () => {
          if (stop) return
          if (v.videoWidth) {
            const code = decode(pixels(v, v.videoWidth, v.videoHeight, 720, canvas), false)
            if (code) cb.current(code)
          }
          timer = setTimeout(tick, 150)
        }
        tick()
      } catch {
        if (!stop) setErr(true)
      }
    })()
    return () => {
      stop = true
      clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [on])
  return { video, err }
}

const STARTING: LinkState = { s: 'starting' }
const noSub = () => () => {}

/**
 * Links a device with no internet over QR codes (see net/qrlink): each one shows its code and
 * scans the other's with the camera, or from a photo. `board` is the board this was opened from
 * (none from the home screen); whoever doesn't have the board ends up opening it.
 */
export function QrLinkDialog({ board, onClose }: { board?: BoardRef; onClose: () => void }) {
  const nav = useNavigate()
  // made in an effect, so each attempt is one QWBP connection that is closed with it
  const [attempt, setAttempt] = useState(0)
  const [link, setLink] = useState<QrLink | null>(null)
  const boardRef = useRef(board)
  useEffect(() => {
    const l = new QrLink(boardRef.current)
    setLink(l)
    return () => l.cancel()
  }, [attempt])
  const st = useSyncExternalStore(link?.subscribe ?? noSub, link?.getState ?? (() => STARTING))
  const [photoMsg, setPhotoMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const scanning = st.s === 'ready' && !st.scanned
  const { video, err } = useScanner(scanning, (b) => void link?.scan(b))

  const close = () => {
    link?.cancel()
    onClose()
  }
  useBackLayer(true, close)

  const done = st.s === 'done' ? st : null
  useEffect(() => {
    if (!done) return
    if (!done.join) return onClose()
    touchBoard(done.board.id, done.board.name || undefined)
    // this dialog's history entry comes off first (leaveLayers closes it), then the board opens;
    // from the home screen, its back arrow should lead home again
    leaveLayers(() => nav(`/board/${done.board.id}`, { state: { fromHome: !board } }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done])

  const fromPhoto = async (f: File | undefined) => {
    if (!f) return
    setPhotoMsg('Reading…')
    try {
      const [decode, bmp] = await Promise.all([loadDecoder(), createImageBitmap(f)])
      const code = decode(pixels(bmp, bmp.width, bmp.height, 1600), true)
      bmp.close()
      setPhotoMsg(code && link && (await link.scan(code)) ? '' : 'No code from the other device found in that photo.')
    } catch {
      setPhotoMsg('Couldn’t read that photo.')
    }
  }

  const retry = () => {
    setPhotoMsg('')
    setAttempt((n) => n + 1)
  }

  let status = ''
  if (st.s === 'starting') status = 'Making a code…'
  else if (st.s === 'ready') status = st.scanned ? 'Got their code. Now let them scan yours.' : 'Point the camera at the other device’s code, and let it scan yours.'
  else if (st.s === 'connecting') status = 'Connecting…'
  else if (st.s === 'failed') status = st.msg

  return (
    <div
      className={d.backdrop}
      data-nodrag
      onPointerDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') close()
      }}
    >
      <div className={`${d.box} ${s.box}`} role="dialog" aria-modal="true" aria-labelledby="qrlink-title">
        <b id="qrlink-title">{board ? 'Add offline peer' : 'Join offline peer'}</b>
        <p>Connect a device with no internet. Both devices need to be on the same Wi-Fi or hotspot, and each one scans the other’s code.</p>

        {st.s === 'choose' ? (
          <p className={s.choose}>
            {st.waiting ? (
              `Waiting for ${st.peer}…`
            ) : (
              <>
                <b>{st.peer}</b> is on “{st.board.name || 'Untitled board'}”. Join it, or stay here so they can join this one?
              </>
            )}
          </p>
        ) : (
          st.s !== 'failed' && (
            <div className={s.pair}>
              <figure>
                {st.s === 'ready' ? <QrCode text={st.qr} label="Your connection code" /> : <div className={s.placeholder} />}
                <figcaption>Your code</figcaption>
              </figure>
              <figure>
                <div className={s.camera}>
                  {scanning && !err && <video ref={video} muted playsInline />}
                  {(!scanning || err) && <span>{err ? 'No camera. Use a photo instead.' : st.s === 'ready' ? 'Scanned' : null}</span>}
                </div>
                <figcaption>Their code</figcaption>
              </figure>
            </div>
          )
        )}

        {status && <p className={st.s === 'failed' ? s.error : s.status} role="status">{status}</p>}
        {photoMsg && <p className={s.status}>{photoMsg}</p>}

        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void fromPhoto(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
        <div className={d.buttons}>
          {scanning && (
            <button type="button" className={s.left} onClick={() => fileRef.current?.click()}>
              <Icon name="image" size={15} /> Scan from photo
            </button>
          )}
          {st.s === 'choose' && !st.waiting ? (
            <>
              <button type="button" onClick={() => link?.stay()}>Stay</button>
              <button type="button" className={d.primary} onClick={() => link?.join()}>Join theirs</button>
            </>
          ) : (
            <>
              <button type="button" onClick={close}>{st.s === 'failed' ? 'Close' : 'Cancel'}</button>
              {st.s === 'failed' && (
                <button type="button" className={d.primary} onClick={retry}>Try again</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
