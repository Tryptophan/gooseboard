import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { renameBoardLocal, saveProfile, USER_COLORS } from '../lib/storage'
import { toast } from '../lib/toast'
import { signalStatus } from '../net/signal'
import { usePeers, useSession } from '../state/session'
import { useThemeToggle, useUi, useUiDispatch } from '../state/ui'
import { copyDialog } from './Dialog'
import { fitAvatars, Goose, MoreChip, useBudget } from './Avatars'
import { Icon } from './Icons'
import s from './Chrome.module.css'

function useConnection() {
  const { p2p } = useSession()
  const [st, setSt] = useState({ servers: [] as { url: string; kind: string; connected: boolean }[], links: 0 })
  useEffect(() => {
    let last = ''
    const read = () => {
      const servers = signalStatus().flatMap((t) => t.endpoints.map((e) => ({ url: e.url, kind: t.kind, connected: e.open })))
      const next = { servers, links: p2p.peerCount }
      const key = JSON.stringify(next)
      if (key !== last) {
        last = key
        setSt(next)
      }
    }
    read()
    const t = setInterval(read, 1000)
    return () => clearInterval(t)
  }, [p2p])
  return st
}

function useBoardName(boardId: string) {
  const { store } = useSession()
  const [name, setName] = useState(store.name)
  useEffect(() => {
    const h = () => {
      setName(store.name)
      if (store.name) renameBoardLocal(boardId, store.name)
    }
    h()
    store.meta.observe(h)
    return () => store.meta.unobserve(h)
  }, [store, boardId])
  return name
}

export function TopBar({ boardId }: { boardId: string }) {
  const session = useSession()
  const { store } = session
  const { peers: allPeers } = usePeers()
  const ui = useUi()
  const dispatch = useUiDispatch()
  const conn = useConnection()
  const theme = useThemeToggle()
  const name = useBoardName(boardId)
  const [draft, setDraft] = useState<string | null>(null)
  const [showConn, setShowConn] = useState(false)
  const [showMe, setShowMe] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const bodyRef = useRef(document.body)
  const leftRef = useRef<HTMLDivElement>(null)
  const restRef = useRef<HTMLDivElement>(null)
  const meRef = useRef<HTMLDivElement>(null)
  const avatarBudget = useBudget(bodyRef, 1) - useBudget(leftRef, 1) - useBudget(restRef, 1) - 80

  // self first, so the "+N" overflow hides other people rather than your own profile button
  const peers = [...allPeers].sort((a, b) => Number(b.isSelf) - Number(a.isSelf))
  const shown = fitAvatars(peers.length, avatarBudget)
  const clickPeer = (p: (typeof peers)[number]) => {
    setShowMore(false)
    if (p.isSelf) setShowMe(!showMe)
    else dispatch({ type: 'follow', clientId: ui.follow === p.clientId ? null : p.clientId })
  }
  const updateProfile = (patch: Parameters<typeof saveProfile>[0]) => {
    store.setProfile(saveProfile(patch))
    session.presence.refresh()
  }

  useEffect(() => {
    if (!showMe) return
    // the self avatar toggles the popover on its own click, so pressing it isn't "outside"
    const h = (e: PointerEvent) => {
      const t = e.target as Element
      if (!meRef.current?.contains(t) && !t.closest?.('[data-me-toggle]')) setShowMe(false)
    }
    window.addEventListener('pointerdown', h, true)
    return () => window.removeEventListener('pointerdown', h, true)
  }, [showMe])

  const up = conn.servers.filter((x) => x.connected).length
  const others = peers.filter((p) => !p.isSelf).length
  const me = peers.find((p) => p.isSelf)

  const share = async () => {
    const url = window.location.href
    try {
      await navigator.clipboard.writeText(url)
      toast('Board link copied. Anyone with it can join and edit.')
    } catch {
      void copyDialog('Copy this link', url, 'Anyone with it can join and edit.')
    }
  }

  const commitName = () => {
    if (draft !== null && draft.trim() && draft.trim() !== name) {
      store.setName(draft.trim())
      renameBoardLocal(boardId, draft.trim())
    }
    setDraft(null)
  }


  return (
    <>
      <div className={`${s.panelBar} ${s.topLeft}`} data-nodrag ref={leftRef}>
        <Link to="/" className={s.logo} title="All boards">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} width={26} height={26} alt="Gooseboard" />
        </Link>
        <input
          className={s.boardName}
          value={draft ?? name}
          placeholder="Untitled board"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setDraft(null)
          }}
          size={Math.max(12, (draft ?? name).length + 1)}
        />
        <button className={s.status} onClick={() => setShowConn(!showConn)} title="Connection status">
          <span className={`${s.led} ${up > 0 ? s.ledOk : s.ledBad}`} />
          <span className={s.label}>{up > 0 ? (others ? `${others + 1} people` : 'Just you') : 'Offline'}</span>
        </button>
      </div>

      {showConn && (
        <div className={`${s.popover} ${s.connPop}`} data-nodrag>
          <b>Connection</b>
          <p>
            Board data goes <u>directly between browsers</u> (WebRTC mesh). Public Nostr relays and WebTorrent trackers only introduce peers, and only ever see encrypted handshakes.
          </p>
          <ul>
            {conn.servers.map((x) => (
              <li key={x.url}>
                <span className={`${s.led} ${x.connected ? s.ledOk : s.ledBad}`} /> {x.url.replace('wss://', '').replace(/\/announce$/, '')} <span className={s.muted}>{x.kind === 'nostr' ? 'Nostr' : 'tracker'}</span>
              </li>
            ))}
          </ul>
          <p className={s.muted}>
            {up === 0 ? 'No relay or tracker reachable: edits are saved locally and will sync when one is. ' : ''}
            {conn.links} direct link{conn.links === 1 ? '' : 's'} · STUN only (no TURN relay)
          </p>
        </div>
      )}

      <div className={`${s.panelBar} ${s.topRight}`} data-nodrag>
        <div className={s.avatars}>
          {peers.slice(0, shown).map((p) => (
            <button
              key={p.clientId}
              className={`${s.avatar} ${ui.follow === p.clientId ? s.following : ''}`}
              style={{ background: p.color }}
              title={p.isSelf ? `${p.name} (you): edit profile` : ui.follow === p.clientId ? `Following ${p.name}: click to stop` : `${p.name}: click to follow their view`}
              onClick={() => clickPeer(p)}
              data-me-toggle={p.isSelf || undefined}
            >
              <Goose color={p.color} />
            </button>
          ))}
          {shown < peers.length && <MoreChip hidden={peers.slice(shown).map((p) => p.name)} onClick={() => setShowMore(!showMore)} />}
        </div>
        <div className={s.rest} ref={restRef}>
        <button className={s.iconBtn} title={theme.dark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={theme.toggle}>
          <Icon name={theme.dark ? 'moon' : 'sun'} size={18} />
        </button>
        <button className={s.shareBtn} onClick={() => void share()} aria-label="Share">
          <Icon name="share" size={16} /> <span className={s.label}>Share</span>
        </button>
        </div>
      </div>

      {showMore && shown < peers.length && (
        <div className={`${s.popover} ${s.mePop}`} data-nodrag>
          <b>Everyone here</b>
          <ul className={s.peerList}>
            {peers.map((p) => (
              <li key={p.clientId}>
                <button className={ui.follow === p.clientId ? s.following : ''} onClick={() => clickPeer(p)} data-me-toggle={p.isSelf || undefined}>
                  <span className={s.avatar} style={{ background: p.color }}><Goose color={p.color} /></span>
                  {p.name}
                  <span className={s.muted}>{p.isSelf ? 'you' : ui.follow === p.clientId ? 'following' : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showMe && me && (
        <div className={`${s.popover} ${s.mePop}`} data-nodrag ref={meRef}>
          <b>Your profile</b>
          <input
            value={me.name}
            maxLength={24}
            onChange={(e) => {
              updateProfile({ name: e.target.value })
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') setShowMe(false)
            }}
          />
          <div className={s.swatches}>
            {USER_COLORS.map((c) => (
              <button key={c} className={`${s.swatch} ${me.color === c ? s.swatchOn : ''}`} style={{ background: c }} onClick={() => updateProfile({ color: c })} aria-label={c} />
            ))}
          </div>
          <p className={s.muted}>Saved in this browser only. No account needed.</p>
        </div>
      )}
    </>
  )
}
