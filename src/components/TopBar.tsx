import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { leaveLayers } from '../lib/back'
import { ACCESSORIES, ACCESSORY_LABELS, renameBoardLocal, saveProfile, USER_COLORS } from '../lib/storage'
import { useUpdateReady } from '../net/pwa'
import { signalStatus } from '../net/signal'
import { usePeers, useSession } from '../state/session'
import { useUi, useUiDispatch } from '../state/ui'
import { shareDialog } from './Dialog'
import { AccessoryIcon, fitAvatars, Goose, MoreChip, useBudget } from './Avatars'
import { Icon } from './Icons'
import { QrLinkDialog } from './QrLink'
import s from './Chrome.module.css'

/** Closes a popover on a press anywhere outside it (and outside its toggle), or on Escape. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>, toggle: string) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      const t = e.target as Element
      if (!ref.current?.contains(t) && !t.closest?.(toggle)) closeRef.current()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current()
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [open, ref, toggle])
}

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

let measurer: CanvasRenderingContext2D | null = null

/** Who you're following, held on screen until you stop. */
export function FollowBanner() {
  const { peers } = usePeers()
  const ui = useUi()
  const dispatch = useUiDispatch()
  const stacked = useUpdateReady()
  const p = ui.follow == null ? undefined : peers.find((q) => q.clientId === ui.follow)
  if (!p) return null
  // above the new-version banner when both are up
  return (
    <div className={`${s.update} ${stacked ? s.stacked : ''}`} role="status">
      Following {p.name}
      <button onClick={() => dispatch({ type: 'follow', clientId: null })}>Cancel</button>
    </div>
  )
}

export function TopBar({ boardId }: { boardId: string }) {
  const location = useLocation()
  const nav = useNavigate()
  const session = useSession()
  const { store } = session
  const { peers: allPeers } = usePeers()
  const ui = useUi()
  const dispatch = useUiDispatch()
  const conn = useConnection()
  const name = useBoardName(boardId)
  const [draft, setDraft] = useState<string | null>(null)
  const [showConn, setShowConn] = useState(false)
  const [showMe, setShowMe] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [linking, setLinking] = useState(false)
  const connRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef(document.body)
  const leftRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const shownName = (draft ?? name) || 'Untitled board'
  // the name box as wide as its text, so the space either side of it matches
  useLayoutEffect(() => {
    const fit = () => {
      const el = nameRef.current
      if (!el) return
      const cs = getComputedStyle(el)
      const ctx = (measurer ??= document.createElement('canvas').getContext('2d'))
      if (!ctx) return
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      el.style.width = `${Math.ceil(ctx.measureText(shownName).width) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2}px`
    }
    fit()
    // again once the web font is in, which is wider than the fallback
    void document.fonts?.ready.then(fit)
  }, [shownName])
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

  // each button toggles its popover on its own click, so pressing it isn't "outside"
  useDismiss(showMe, () => setShowMe(false), meRef, '[data-me-toggle]')
  useDismiss(showConn, () => setShowConn(false), connRef, '[data-conn-toggle]')
  useDismiss(showMore, () => setShowMore(false), moreRef, '[data-more-toggle]')

  const up = conn.servers.filter((x) => x.connected).length
  const relaysUp = conn.servers.filter((x) => x.connected && x.kind !== 'mesh').length
  const others = peers.filter((p) => !p.isSelf).length
  const me = peers.find((p) => p.isSelf)

  // the link, without whatever state the page's history carries
  const share = async () => {
    const url = `${window.location.origin}${window.location.pathname}#/board/${boardId}`
    let copied = false
    try {
      await navigator.clipboard.writeText(url)
      copied = true
    } catch {
      /* refused: the dialog's Copy button tries again, with the link selected */
    }
    void shareDialog('Share this board', url, copied, 'Scan the code or send the link. Anyone with it can join and edit.')
  }

  const commitName = () => {
    if (draft !== null && draft.trim() && draft.trim() !== name) {
      store.setName(draft.trim())
      renameBoardLocal(boardId, draft.trim())
    }
    setDraft(null)
  }


  // opened from Home: go back to it; otherwise (a shared link) Home takes this board's place, so
  // the system back from Home never lands on a board
  const back = (e: MouseEvent) => {
    e.preventDefault()
    const fromHome = (location.state as { fromHome?: boolean } | null)?.fromHome
    leaveLayers(() => (fromHome ? nav(-1) : nav('/', { replace: true })))
  }

  return (
    <>
      <div className={`${s.panelBar} ${s.topLeft}`} data-nodrag ref={leftRef}>
        <Link to="/" className={s.back} title="All boards" aria-label="Back to all boards" onClick={back}>
          <Icon name="arrowLeft" />
        </Link>
        <input
          ref={nameRef}
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
        />
        <button className={s.status} onClick={() => setShowConn(!showConn)} title="Connection status" data-conn-toggle>
          <span className={`${s.led} ${up > 0 ? s.ledOk : s.ledBad}`} />
          <span className={s.label}>{up > 0 ? (others ? `${others + 1} people` : 'Just you') : 'Offline'}</span>
        </button>
      </div>

      {showConn && (
        <div className={`${s.popover} ${s.connPop}`} data-nodrag ref={connRef}>
          <b>Connection</b>
          <p>
            Board data goes <u>directly between browsers</u> (WebRTC mesh). Public Nostr relays, WebTorrent trackers, and peers you’re already linked to only introduce peers, and only ever see encrypted handshakes.
          </p>
          <ul>
            {conn.servers.map((x) => (
              <li key={x.url}>
                <span className={`${s.led} ${x.connected ? s.ledOk : s.ledBad}`} /> {x.url.replace('wss://', '').replace(/\/announce$/, '')} <span className={s.muted}>{x.kind === 'nostr' ? 'Nostr' : x.kind === 'mesh' ? 'via peers' : 'tracker'}</span>
              </li>
            ))}
          </ul>
          <p className={s.muted}>
            {relaysUp === 0 ? 'No relay or tracker reachable: edits are saved locally and sync when one is, or with peers linked by QR code. ' : ''}
            {conn.links} direct link{conn.links === 1 ? '' : 's'} · STUN only (no TURN relay)
          </p>
          <button
            className={s.connAction}
            onClick={() => {
              setShowConn(false)
              setLinking(true)
            }}
          >
            Add offline peer
          </button>
        </div>
      )}
      {linking && <QrLinkDialog board={{ id: boardId, name }} onClose={() => setLinking(false)} />}

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
              <Goose accessory={p.accessory} />
            </button>
          ))}
          {shown < peers.length && <MoreChip hidden={peers.slice(shown).map((p) => p.name)} onClick={() => setShowMore(!showMore)} />}
        </div>
        <div className={s.rest} ref={restRef}>
        <button className={s.shareBtn} onClick={() => void share()} aria-label="Share">
          <Icon name="share" size={16} /> <span className={s.label}>Share</span>
        </button>
        </div>
      </div>

      {showMore && shown < peers.length && (
        <div className={`${s.popover} ${s.mePop}`} data-nodrag ref={moreRef}>
          <b>Everyone here</b>
          <ul className={s.peerList}>
            {peers.map((p) => (
              <li key={p.clientId}>
                <button className={ui.follow === p.clientId ? s.following : ''} onClick={() => clickPeer(p)} data-me-toggle={p.isSelf || undefined}>
                  <span className={s.avatar} style={{ background: p.color }}><Goose accessory={p.accessory} /></span>
                  <span className={s.peerName}>{p.name}</span>
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
          <div className={s.meRow}>
            <span className={s.mePreview} style={{ background: me.color }}>
              <Goose accessory={me.accessory} />
            </span>
            <label className={s.meName}>
              <input
                value={me.name}
                maxLength={24}
                aria-label="Display name"
                onChange={(e) => {
                  updateProfile({ name: e.target.value })
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') setShowMe(false)
                }}
              />
            </label>
          </div>
          <div className={s.swatches}>
            {USER_COLORS.map((c) => (
              <button key={c} className={`${s.swatch} ${me.color === c ? s.swatchOn : ''}`} style={{ background: c }} onClick={() => updateProfile({ color: c })} aria-label={c} />
            ))}
          </div>
          <div className={s.swatches}>
            {ACCESSORIES.map((a) => (
              <button
                key={a}
                className={`${s.swatch} ${s.accChip} ${me.accessory === a ? s.swatchOn : ''}`}
                onClick={() => updateProfile({ accessory: a })}
                title={ACCESSORY_LABELS[a]}
                aria-label={ACCESSORY_LABELS[a]}
                aria-pressed={me.accessory === a}
              >
                <AccessoryIcon kind={a} />
              </button>
            ))}
          </div>
          <p className={s.muted}>Saved in this browser only. No account needed.</p>
        </div>
      )}
    </>
  )
}
