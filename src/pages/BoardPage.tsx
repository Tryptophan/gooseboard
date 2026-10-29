import { useEffect, useMemo, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { BoardSurface } from '../components/BoardSurface'
import { FolderPanel } from '../components/FolderPanel'
import { Goosey } from '../components/Goosey'
import { NoteModal } from '../components/Note'
import { Icon } from '../components/Icons'
import { Minimap } from '../components/Minimap'
import { PreviewProvider } from '../components/Preview'
import { Toolbar } from '../components/Toolbar'
import { TopBar } from '../components/TopBar'
import { RelinkBanner, useLeaveGuard } from '../components/TransferPanel'
import { unionBounds } from '../lib/geometry'
import { isValidBoardId } from '../lib/ids'
import { loadCamera, saveCamera, takePendingName, touchBoard } from '../lib/storage'
import { useCoarse, useWakeLock } from '../lib/touch'
import { acquireSession, releaseSession, type Session } from '../net/session'
import { CameraProvider, useCamera } from '../state/camera'
import { SessionProvider, useSnapshot } from '../state/session'
import { useUiDispatch } from '../state/ui'
import { watchEmbedTitles } from '../lib/embedTitle'
import chrome from '../components/Chrome.module.css'

export default function BoardPage() {
  const { id } = useParams()
  if (!isValidBoardId(id)) return <Navigate to="/" replace />
  return <BoardLoader key={id} id={id} />
}

function BoardLoader({ id }: { id: string }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const dispatch = useUiDispatch()

  useEffect(() => {
    dispatch({ type: 'reset' })
    const s = acquireSession(id)
    touchBoard(id)
    setSession(s)
    const stopTitles = watchEmbedTitles(s.store)
    s.store.onLoaded(() => {
      const pending = takePendingName(id)
      if (pending) s.store.setName(pending)
      setReady(true)
    })
    return () => {
      stopTitles()
      releaseSession(id)
    }
  }, [id, dispatch])

  if (!session || !ready) return <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>Opening board…</div>
  return (
    <SessionProvider session={session}>
      <Board id={id} />
    </SessionProvider>
  )
}

function Board({ id }: { id: string }) {
  const initial = useMemo(() => loadCamera(id), [id])
  useLeaveGuard()
  // on a phone or tablet the screen stays on while a board is open
  useWakeLock(useCoarse())
  return (
    <CameraProvider initial={initial}>
      <PreviewProvider>
        <BoardSurface />
        <TopBar boardId={id} />
        <RelinkBanner />
        <FolderPanel />
        <NoteModal />
        <Toolbar />
        <div className={chrome.corner}>
          <Goosey />
          <ZoomControls />
        </div>
        <Minimap />
        <CameraSaver id={id} />
      </PreviewProvider>
    </CameraProvider>
  )
}

function CameraSaver({ id }: { id: string }) {
  const { cam } = useCamera()
  useEffect(() => {
    const t = setTimeout(() => saveCamera(id, cam), 400)
    return () => clearTimeout(t)
  }, [id, cam])
  return null
}

function ZoomControls() {
  const camApi = useCamera()
  const snap = useSnapshot()
  const fit = () => {
    const b = unionBounds(snap.surface)
    if (b) camApi.fitRect(b)
    else camApi.centerOn(0, 0, 1)
  }
  return (
    <div className={chrome.zoom} data-nodrag>
      <button className={chrome.step} title="Zoom out  Ctrl+-" onClick={() => camApi.zoomTo(camApi.cam.z / 1.25)}>
        <Icon name="minus" size={16} />
      </button>
      <button title="Reset to 100%  Ctrl+0" onClick={() => camApi.zoomTo(1)}>
        {Math.round(camApi.cam.z * 100)}%
      </button>
      <button className={chrome.step} title="Zoom in  Ctrl+=" onClick={() => camApi.zoomTo(camApi.cam.z * 1.25)}>
        <Icon name="plus" size={16} />
      </button>
      <button title="Zoom to fit everything  Shift+1" onClick={fit}>
        <Icon name="fit" size={16} />
      </button>
    </div>
  )
}
