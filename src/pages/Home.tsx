import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ROOM_PREFIX } from '../config'
import { newBoardId, parseBoardRef } from '../lib/ids'
import { forgetBoard, getBoards, getProfile, renameBoardLocal, saveProfile, touchBoard, USER_COLORS, type BoardEntry } from '../lib/storage'
import { Icon } from '../components/Icons'
import { useUi, useUiDispatch } from '../state/ui'
import s from './Home.module.css'

const boardUrl = (id: string) => `${window.location.origin}${window.location.pathname}#/board/${id}`

function ago(ts: number) {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

export default function Home() {
  const nav = useNavigate()
  const ui = useUi()
  const dispatch = useUiDispatch()
  const [boards, setBoards] = useState<BoardEntry[]>(getBoards)
  const [join, setJoin] = useState('')
  const [joinErr, setJoinErr] = useState(false)
  const [profile, setProfile] = useState({ ...getProfile() })
  const [copied, setCopied] = useState<string | null>(null)

  const create = () => {
    const id = newBoardId()
    touchBoard(id)
    nav(`/board/${id}`)
  }
  const doJoin = () => {
    const id = parseBoardRef(join)
    if (!id) return setJoinErr(true)
    nav(`/board/${id}`)
  }
  const remove = (b: BoardEntry) => {
    if (!window.confirm(`Remove “${b.name}” from this browser? Its local copy is deleted; other people who have it keep theirs.`)) return
    forgetBoard(b.id)
    try {
      indexedDB.deleteDatabase(ROOM_PREFIX + b.id)
    } catch {
      /* ignore */
    }
    setBoards(getBoards())
  }
  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(boardUrl(id))
      setCopied(id)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      window.prompt('Copy this link', boardUrl(id))
    }
  }
  const nextTheme = { system: 'light', light: 'dark', dark: 'system' } as const

  return (
    <main className={s.page}>
      <header className={s.head}>
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} width={44} height={44} alt="" />
        <div>
          <h1>Gooseboard</h1>
          <p>A peer-to-peer infinite canvas. Notes, files, folders and ink, shared straight between browsers.</p>
        </div>
        <button className={s.theme} onClick={() => dispatch({ type: 'theme', theme: nextTheme[ui.theme] })} title={`Theme: ${ui.theme}`}>
          <Icon name={ui.theme === 'dark' ? 'moon' : 'sun'} size={18} />
        </button>
      </header>

      <section className={s.actions}>
        <button className={s.primary} onClick={create}>
          <Icon name="plus" size={18} /> New board
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            doJoin()
          }}
        >
          <input
            value={join}
            onChange={(e) => {
              setJoin(e.target.value)
              setJoinErr(false)
            }}
            placeholder="Paste a board link or ID to join"
            aria-invalid={joinErr}
          />
          <button type="submit">Join</button>
        </form>
      </section>

      <section>
        <h2>Your boards</h2>
        {boards.length === 0 ? (
          <p className={s.empty}>No boards yet. Create one, then send the link to anyone you want on it.</p>
        ) : (
          <ul className={s.list}>
            {boards.map((b) => (
              <li key={b.id}>
                <button className={s.open} onClick={() => nav(`/board/${b.id}`)}>
                  <b>{b.name || 'Untitled board'}</b>
                  <span>
                    {b.id} · opened {ago(b.lastOpened)}
                  </span>
                </button>
                <button
                  title="Rename"
                  onClick={() => {
                    const n = window.prompt('Board name', b.name)
                    if (n?.trim()) {
                      renameBoardLocal(b.id, n.trim())
                      setBoards(getBoards())
                    }
                  }}
                >
                  Rename
                </button>
                <button title="Copy invite link" onClick={() => void copy(b.id)}>
                  {copied === b.id ? 'Copied!' : 'Copy link'}
                </button>
                <button title="Remove from this browser" className={s.del} onClick={() => remove(b)}>
                  <Icon name="trash" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={s.profile}>
        <h2>You</h2>
        <p>No accounts. Your name and color live in this browser and show on your cursor.</p>
        <div className={s.profileRow}>
          <input
            value={profile.name}
            maxLength={24}
            onChange={(e) => setProfile({ ...saveProfile({ name: e.target.value }) })}
            aria-label="Display name"
          />
          {USER_COLORS.map((c) => (
            <button
              key={c}
              className={`${s.sw} ${profile.color === c ? s.swOn : ''}`}
              style={{ background: c }}
              onClick={() => setProfile({ ...saveProfile({ color: c }) })}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
      </section>

      <footer className={s.foot}>
        Boards sync directly between browsers over WebRTC (Yjs CRDT). Public signaling servers only introduce peers. Files you share stay on your disk and stream on demand while you’re online.
      </footer>
    </main>
  )
}
