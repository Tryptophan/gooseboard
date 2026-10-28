import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { engine } from '../ai/engine'
import { formatMB, isDownloaded, whisperSpec, type ModelSpec } from '../ai/models'
import { voice } from '../ai/voice'
import { useCamera } from '../state/camera'
import { useSession } from '../state/session'
import { useUi, useUiDispatch } from '../state/ui'
import { Icon } from './Icons'
import s from './Chrome.module.css'
import d from './Dialog.module.css'

const MIC_EVENT = 'gooseboard:mic'
/** The M shortcut: presses the toolbar mic. */
export const toggleMic = () => window.dispatchEvent(new Event(MIC_EVENT))

/** The toolbar mic: talk, and what's said is appended to the selected note, or a new one (in the open folder, if any). */
export function MicButton() {
  const { store } = useSession()
  const ui = useUi()
  const dispatch = useUiDispatch()
  const cam = useCamera()
  const st = useSyncExternalStore(voice.subscribe, voice.getState)
  const [asking, setAsking] = useState<ModelSpec | null>(null)

  // leaving the board ends the recording
  useEffect(() => () => void voice.stop(), [store])

  const begin = async () => {
    const parent = ui.openFolder
    const sel = ui.editing ?? (ui.selection.length === 1 ? ui.selection[0] : null)
    const into = sel && store.getSnapshot().all.get(sel)?.type === 'note' ? sel : undefined
    await voice.start(store, cam.viewCenter(), parent, into)
    const now = voice.getState()
    if (now.phase === 'listening' && !into && !parent) dispatch({ type: 'select', ids: [now.note] })
  }
  const click = async () => {
    if (st.phase !== 'idle') return void voice.stop()
    const spec = await whisperSpec()
    if (await isDownloaded(spec)) void begin()
    else setAsking(spec)
  }

  const clickRef = useRef(click)
  clickRef.current = click
  useEffect(() => {
    const h = () => void clickRef.current()
    window.addEventListener(MIC_EVENT, h)
    return () => window.removeEventListener(MIC_EVENT, h)
  }, [])

  const live = st.phase === 'listening'
  const title = live ? 'Stop voice note  (M)' : 'Voice note  (M)'
  return (
    <>
      <button
        className={`${live ? s.micLive : ''} ${live && st.speaking ? s.micHeard : ''} ${st.phase === 'starting' ? s.micStarting : ''}`}
        aria-pressed={live}
        title={title}
        onClick={() => void click()}
      >
        <Icon name="mic" />
      </button>
      {asking && (
        <DownloadModal
          spec={asking}
          onClose={(ok) => {
            setAsking(null)
            if (ok) void begin()
          }}
        />
      )}
    </>
  )
}

/** Asks once before the speech model downloads, then shows the download with a cancel button. */
function DownloadModal({ spec, onClose }: { spec: ModelSpec; onClose: (ok: boolean) => void }) {
  const [pct, setPct] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const download = () => {
    setPct(0)
    setErr(null)
    // ask the browser not to evict the weights under storage pressure
    void navigator.storage?.persist?.().catch(() => {})
    engine.load(spec, (l, t) => t && setPct(l / t)).then(
      () => onClose(true),
      (e: Error) => e.message !== 'stopped' && (setPct(null), setErr(e.message)),
    )
  }
  const cancel = () => {
    // terminating the worker abandons the download; what's cached so far is kept for next time
    if (pct !== null) engine.reset()
    onClose(false)
  }

  // portalled: the toolbar is transformed, which would pin a fixed backdrop to it
  return createPortal(
    <div
      className={d.backdrop}
      data-nodrag
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') cancel()
      }}
    >
      <div className={d.box} role="dialog" aria-modal="true" aria-labelledby="mic-dl-title">
        <b id="mic-dl-title">{pct === null ? 'Download the speech model?' : 'Downloading the speech model…'}</b>
        <p>Voice notes need a speech model ({formatMB(spec.mb)}). It downloads once and stays in this browser. Your voice never leaves this device.</p>
        {pct !== null && (
          <div className={s.bar} role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${Math.max(2, pct * 100)}%` }} />
          </div>
        )}
        {err && <p>Couldn’t download it: {err}</p>}
        <div className={d.buttons}>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          {pct === null && (
            <button type="button" className={d.primary} autoFocus onClick={download}>
              {err ? 'Try again' : `Download ${formatMB(spec.mb)}`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
