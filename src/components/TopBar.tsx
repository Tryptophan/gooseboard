import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { renameBoardLocal, saveProfile, USER_COLORS } from '../lib/storage'
import { toast } from '../lib/toast'
import { signalStatus } from '../net/signal'
import { usePeers, useSession } from '../state/session'
import { useUi, useUiDispatch } from '../state/ui'
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
  const { peers } = usePeers()
  const ui = useUi()
  const dispatch = useUiDispatch()
  const conn = useConnection()
  const name = useBoardName(boardId)
  const [draft, setDraft] = useState<string | null>(null)
  const [showConn, setShowConn] = useState(false)
  const [showMe, setShowMe] = useState(false)

  const up = conn.servers.filter((x) => x.connected).length
  const others = peers.filter((p) => !p.isSelf).length
  const me = peers.find((p) => p.isSelf)

  const share = async () => {
    const url = window.location.href
    try {
      await navigator.clipboard.writeText(url)
      toast('Board link copied. Anyone with it can join and edit.')
    } catch {
      window.prompt('Copy this link', url)
    }
  }

  const commitName = () => {
    if (draft !== null && draft.trim() && draft.trim() !== name) {
      store.setName(draft.trim())
      renameBoardLocal(boardId, draft.trim())
    }
    setDraft(null)
  }

  const nextTheme = { system: 'light', light: 'dark', dark: 'system' } as const

  return (
    <>
      <div className={`${s.panelBar} ${s.topLeft}`} data-nodrag>
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
          {up > 0 ? (others ? `${others + 1} people` : 'Just you') : 'Offline'}
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
          {peers.map((p) => (
            <button
              key={p.clientId}
              className={`${s.avatar} ${ui.follow === p.clientId ? s.following : ''}`}
              style={{ background: p.color }}
              title={p.isSelf ? `${p.name} (you): edit profile` : ui.follow === p.clientId ? `Following ${p.name}: click to stop` : `${p.name}: click to follow their view`}
              onClick={() => (p.isSelf ? setShowMe(!showMe) : dispatch({ type: 'follow', clientId: ui.follow === p.clientId ? null : p.clientId }))}
            >
              {p.name.slice(0, 1).toUpperCase()}
            </button>
          ))}
        </div>
        <button className={s.iconBtn} title={`Theme: ${ui.theme} (click for ${nextTheme[ui.theme]})`} onClick={() => dispatch({ type: 'theme', theme: nextTheme[ui.theme] })}>
          <Icon name={ui.theme === 'dark' ? 'moon' : 'sun'} size={18} />
        </button>
        <button className={s.shareBtn} onClick={() => void share()}>
          <Icon name="share" size={16} /> Share
        </button>
      </div>

      {showMe && me && (
        <div className={`${s.popover} ${s.mePop}`} data-nodrag>
          <b>Your profile</b>
          <input
            value={me.name}
            maxLength={24}
            onChange={(e) => {
              store.setProfile(saveProfile({ name: e.target.value }))
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') setShowMe(false)
            }}
          />
          <div className={s.swatches}>
            {USER_COLORS.map((c) => (
              <button key={c} className={`${s.swatch} ${me.color === c ? s.swatchOn : ''}`} style={{ background: c }} onClick={() => store.setProfile(saveProfile({ color: c }))} aria-label={c} />
            ))}
          </div>
          <p className={s.muted}>Saved in this browser only. No account needed.</p>
        </div>
      )}
    </>
  )
}
