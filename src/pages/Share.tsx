import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icons'
import { formatSize } from '../lib/files'
import { newBoardId } from '../lib/ids'
import { clearShare, readShare, sendShare, type Shared } from '../lib/share'
import { getBoards, touchBoard } from '../lib/storage'
import s from './Home.module.css'

function summary(sh: Shared) {
  const parts: string[] = []
  if (sh.files.length) parts.push(`${sh.files.length} file${sh.files.length === 1 ? '' : 's'} (${formatSize(sh.files.reduce((n, f) => n + f.size, 0))})`)
  if (sh.url || /https?:\/\//.test(sh.text)) parts.push('a link')
  else if (sh.text || sh.title) parts.push('some text')
  return parts.join(' and ')
}

/** #/share: where something shared into the installed app goes. */
export default function Share() {
  const nav = useNavigate()
  const [shared, setShared] = useState<Shared | null | undefined>(undefined)
  const boards = getBoards()
  useEffect(() => {
    void readShare().then(setShared)
  }, [])

  if (shared === undefined) return null
  if (!shared) return <Navigate to="/" replace />

  const pick = async (id: string) => {
    touchBoard(id)
    sendShare(id, shared)
    await clearShare()
    nav(`/board/${id}`, { replace: true })
  }
  const cancel = async () => {
    await clearShare()
    nav('/', { replace: true })
  }

  return (
    <main className={s.page}>
      <h1 className={s.shareTitle}>Add to a board</h1>
      <p className={s.shareWhat}>You’re sharing {summary(shared)}. It stays on this device and streams to the people on the board, like anything you add.</p>
      <section className={s.actions}>
        <button className={s.primary} onClick={() => void pick(newBoardId())}>
          <Icon name="plus" size={18} /> New board
        </button>
        <button onClick={() => void cancel()}>Cancel</button>
      </section>
      {boards.length > 0 && (
        <section>
          <h2 className={s.sectionTitle}>Your boards</h2>
          <ul className={s.list}>
            {boards.map((b) => (
              <li key={b.id}>
                <button className={s.open} onClick={() => void pick(b.id)}>
                  <span className={s.label}>
                    <b>{b.name || 'Untitled board'}</b>
                    <span>{b.id}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
