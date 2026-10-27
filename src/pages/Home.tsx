import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ROOM_PREFIX } from '../config'
import { newBoardId, parseBoardRef } from '../lib/ids'
import { forgetBoard, getBoards, getProfile, renameBoardLocal, renameBoardPending, saveProfile, touchBoard, USER_COLORS, type BoardEntry } from '../lib/storage'
import type { PresenceUser } from '../model/types'
import { watchPresence } from '../net/presence'
import { AvatarStack, Goose, useBudget } from '../components/Avatars'
import { confirmDialog, copyDialog, promptDialog } from '../components/Dialog'
import { Icon } from '../components/Icons'
import { useThemeToggle } from '../state/ui'
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

/** Live presence is watched for this many of the most recently opened boards. */
const WATCHED = 24

/** Who is on each board now; also adopts names peers have given a board since we last opened it. */
function useBoardPresence(boards: BoardEntry[], onRenamed: () => void) {
  const [users, setUsers] = useState<Record<string, PresenceUser[]>>({})
  const ids = boards.slice(0, WATCHED).map((b) => b.id).join(',')
  const renamed = useRef(onRenamed)
  renamed.current = onRenamed
  useEffect(() => {
    const stops = ids.split(',').filter(Boolean).map((id) =>
      watchPresence(id, (p) => {
        setUsers((u) => ({ ...u, [id]: p.users }))
        const e = getBoards().find((b) => b.id === id)
        // a rename made here and not yet carried into the board wins over what peers announce
        if (p.name && e && e.pendingName === undefined && e.name !== p.name) {
          renameBoardLocal(id, p.name)
          renamed.current()
        }
      }),
    )
    return () => stops.forEach((s) => s())
  }, [ids])
  return users
}

export default function Home() {
  const nav = useNavigate()
  const theme = useThemeToggle()
  const [boards, setBoards] = useState<BoardEntry[]>(getBoards)
  const [join, setJoin] = useState('')
  const [joinErr, setJoinErr] = useState(false)
  const [profile, setProfile] = useState({ ...getProfile() })
  const [copied, setCopied] = useState<string | null>(null)
  const online = useBoardPresence(boards, () => setBoards(getBoards()))

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
  const remove = async (b: BoardEntry) => {
    const ok = await confirmDialog({
      title: `Remove “${b.name || 'Untitled board'}”?`,
      message: 'Its copy in this browser is deleted. Other people who have it keep theirs.',
      ok: 'Remove',
      danger: true,
    })
    if (!ok) return
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
      void copyDialog('Copy this link', boardUrl(id), 'Anyone with it can join and edit.')
    }
  }

  return (
    <main className={s.page}>
      <header className={s.head}>
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} width={44} height={44} alt="" />
        <div>
          <h1>Gooseboard</h1>
          <p>A simple collaborative decentralized workspace. Notes, ink, files and folders, shared live between browsers. No accounts, no cloud.</p>
        </div>
        <button className={s.theme} onClick={theme.toggle} title={theme.dark ? 'Switch to light theme' : 'Switch to dark theme'}>
          <Icon name={theme.dark ? 'moon' : 'sun'} size={18} />
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
                  <span className={s.label}>
                    <b>{b.name || 'Untitled board'}</b>
                    <span>
                      {b.id} · opened {ago(b.lastOpened)}
                    </span>
                  </span>
                  <OnlineNow users={online[b.id] ?? []} />
                </button>
                <button
                  title="Rename"
                  onClick={async () => {
                    const n = await promptDialog({ title: 'Rename board', value: b.name, placeholder: 'Untitled board', ok: 'Rename' })
                    if (n && n !== b.name) {
                      renameBoardPending(b.id, n)
                      setBoards(getBoards())
                    }
                  }}
                >
                  Rename
                </button>
                <button title="Copy invite link" onClick={() => void copy(b.id)}>
                  {copied === b.id ? 'Copied!' : 'Copy link'}
                </button>
                <button title="Remove from this browser" className={s.del} onClick={() => void remove(b)}>
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
          <span className={s.me} style={{ background: profile.color }} title="How you look to others">
            <Goose color={profile.color} />
          </span>
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
        Your boards go straight from your browser to the people you share them with. There’s no Gooseboard server in the middle, and no account to sign up for. Files you add stay on your computer and are sent only when someone opens them. Small files are copied to everyone on the board so they’re always handy.
        <p className={s.source}>
          <a href="https://github.com/Tryptophan/gooseboard" target="_blank" rel="noopener noreferrer">
            Source on GitHub
          </a>{' '}
          · MIT licensed
        </p>
      </footer>
    </main>
  )
}

function OnlineNow({ users }: { users: PresenceUser[] }) {
  const ref = useRef<HTMLSpanElement>(null)
  const budget = useBudget(ref, 1)
  return (
    <span ref={ref} className={s.online} title={users.length ? `${users.length} on this board now` : undefined}>
      {users.length > 0 && (
        <>
          {budget - 70 >= 30 && <AvatarStack users={users} budget={budget - 70} />}
          <span className={s.onlineCount}>
            <i /> {users.length} online
          </span>
        </>
      )}
    </span>
  )
}
