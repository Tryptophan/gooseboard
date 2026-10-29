import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { engine } from '../ai/engine'
import { cachedModelBytes, deleteAllModels } from '../ai/models'
import { AUTO_SYNC_CHOICES, getAutoSyncMax, setAutoSyncMax, subscribeAutoSync } from '../lib/autoSync'
import { voice } from '../ai/voice'
import { useBackLayer } from '../lib/back'
import { collectDiag } from '../lib/diag'
import { formatSize } from '../lib/files'
import { getBoards } from '../lib/storage'
import { chatLog } from '../model/chat'
import type { ThemePref } from '../lib/storage'
import { toast } from '../lib/toast'
import { useCoarse } from '../lib/touch'
import { useInstallWay } from '../net/pwa'
import { clearPreviews, previewStats } from '../net/previewCache'
import { clearThumbs, thumbStats } from '../net/thumbCache'
import { getGoosey, openMenu, subscribeGoosey, type Tab } from '../state/goosey'
import { useSession } from '../state/session'
import { useUi, useUiDispatch } from '../state/ui'
import { confirmDialog } from './Dialog'
import { Icon } from './Icons'
import { ChatTab } from './GooseyChat'
import { Reminders } from './Reminders'
import { install } from './Install'
import { TransfersTab, useTransferProgress } from './TransferPanel'
import c from './Chrome.module.css'
import s from './Goosey.module.css'

const useGoosey = () => useSyncExternalStore(subscribeGoosey, getGoosey)

/** Most-recent pointer position, for Goosey's glances. */
const pointer = { x: -1, y: -1 }

/** Goosey: the helper goose in the bottom-left corner. Click him for chat, reminders, settings, and help. */
export function Goosey() {
  const { menu } = useGoosey()
  return (
    <div className={s.wrap} data-nodrag>
      {menu && <Menu tab={menu} />}
      <Character open={!!menu} />
      <TransferBadge />
      <ChatBadge />
    </div>
  )
}

function Character({ open }: { open: boolean }) {
  const { store } = useSession()
  const ref = useRef<HTMLButtonElement>(null)
  const [look, setLook] = useState(0)
  const [hop, setHop] = useState(false)
  // a hovered goose sways faster
  const [hover, setHover] = useState(false)
  const glanceRef = useRef<(force?: boolean) => void>(() => {})

  // glance toward the pointer when something happens (an edit, yours or a peer's, or someone
  // joining), then rest a random while; always tilting back (left), never forward
  useEffect(() => {
    const move = (e: PointerEvent) => {
      pointer.x = e.clientX
      pointer.y = e.clientY
    }
    window.addEventListener('pointermove', move, { passive: true })
    let t: ReturnType<typeof setTimeout> | undefined
    let restUntil = 0
    const glance = (force = false) => {
      const now = Date.now()
      if (!force && now < restUntil) return
      restUntil = now + 6000 + Math.random() * 14000
      const r = ref.current?.getBoundingClientRect()
      // head pivot sits near the top right of the button; tilt toward the pointer, clamped
      const deg = r && pointer.x >= 0 ? (Math.atan2(pointer.y - (r.top + r.height * 0.25), pointer.x - (r.left + r.width * 0.65)) * 180) / Math.PI : -30
      setLook(Math.max(-18, Math.min(-6, deg * 0.4)))
      clearTimeout(t)
      t = setTimeout(() => setLook(0), 1600)
    }
    glanceRef.current = glance

    // the board's own arrival from disk isn't an action
    let live = false
    store.onLoaded(() => (live = true))
    const onEdit = () => live && glance()
    store.items.observeDeep(onEdit)
    const onPeers = ({ added }: { added: number[] }) => added.some((id) => id !== store.awareness.clientID) && glance()
    store.awareness.on('change', onPeers)
    return () => {
      window.removeEventListener('pointermove', move)
      store.items.unobserveDeep(onEdit)
      store.awareness.off('change', onPeers)
      clearTimeout(t)
    }
  }, [store])

  // opening the menu always gets a glance, rested or not
  useEffect(() => {
    if (open) glanceRef.current(true)
  }, [open])

  return (
    <button
      ref={ref}
      className={`${s.goose} ${hop ? s.hop : ''}`}
      aria-label="Goosey: chat, reminders, settings, and help"
      aria-expanded={open}
      onClick={() => {
        setHop(true)
        openMenu(open ? null : 'chat')
      }}
      onAnimationEnd={(e) => e.animationName.includes('hop') && setHop(false)}
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
      onPointerLeave={() => setHover(false)}
      data-goosey-toggle
    >
      {/* with the menu open he keeps a slight tilt back */}
      <GooseyArt look={look || (open ? -8 : 0)} quick={hover} />
    </button>
  )
}

/** A ring on Goosey's left shoulder while files move: how far along all of them are, together. Opens the Transfers tab. */
function TransferBadge() {
  const { count, pct } = useTransferProgress()
  if (!count) return null
  const r = 10
  const len = 2 * Math.PI * r
  return (
    <button className={s.badge} title={`${count} transfer${count > 1 ? 's' : ''}: ${Math.round(pct * 100)}%`} onClick={() => openMenu('transfers')}>
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
        <circle cx="12" cy="12" r={r} className={s.ringBg} />
        <circle cx="12" cy="12" r={r} className={s.ring} strokeDasharray={len} strokeDashoffset={len * (1 - pct)} />
      </svg>
      <Icon name="transfers" size={11} />
    </button>
  )
}

/** Unread chat messages, on Goosey's right shoulder. Opens the Chat tab. */
function ChatBadge() {
  const { store } = useSession()
  const log = chatLog(store)
  const n = useSyncExternalStore(log.subscribe, log.unread)
  const { menu } = useGoosey()
  if (!n || menu === 'chat') return null
  return (
    <button className={s.unread} title={`${n} new message${n > 1 ? 's' : ''}`} onClick={() => openMenu('chat')}>
      {n > 99 ? '99+' : n}
    </button>
  )
}

const calm = matchMedia('(prefers-reduced-motion: reduce)')
const useCalm = () =>
  useSyncExternalStore(
    (l) => {
      calm.addEventListener('change', l)
      return () => calm.removeEventListener('change', l)
    },
    () => calm.matches,
  )

/**
 * The Gooseboard logo, bigger and alive: the neck sways and glances, the eye blinks. The sway and
 * blink are SMIL, not CSS: Chrome draws an SVG element under a running CSS transform animation on
 * a layer of its own, without anti-aliasing, and the tilted neck's edge goes jagged.
 */
function GooseyArt({ look = 0, quick = false }: { look?: number; quick?: boolean }) {
  const neck = 'M22 70V23a9 9 0 0 1 9-9c4 0 7 2 9 4l1 .5V28.5L40 29v41z'
  const still = useCalm()
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden className={s.art}>
      <defs>
        <clipPath id="goosey-tile">
          <rect width="64" height="64" rx="14" />
        </clipPath>
      </defs>
      <rect width="64" height="64" rx="14" className={s.tile} />
      <g clipPath="url(#goosey-tile)">
        <g>
          {!still && <animateTransform attributeName="transform" type="translate" values="0 0; 0 1.5; 0 0" keyTimes="0; 0.5; 1" calcMode="spline" keySplines="0.42 0 0.58 1; 0.42 0 0.58 1" dur={quick ? '1.4s' : '3.2s'} repeatCount="indefinite" />}
          <g className={s.head} style={{ rotate: `${look}deg` }}>
            <path d={neck} className={s.white} />
            <path d="M40 18l11 5.5c1 .5 1 1.5 0 2L40 29z" className={s.beak} />
            <ellipse cx="32" cy="21.5" rx="2.2" ry="2.2" className={s.eye}>
              {!still && <animate attributeName="ry" values="2.2; 2.2; 0.22; 2.2" keyTimes="0; 0.94; 0.96; 1" dur="5.5s" repeatCount="indefinite" />}
            </ellipse>
          </g>
        </g>
      </g>
    </svg>
  )
}


/** labelled on a computer, icons on a phone (Goosey.module.css) */
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'reminders', label: 'Reminders', icon: 'bell' },
  { id: 'transfers', label: 'Transfers', icon: 'transfers' },
  { id: 'settings', label: 'Settings', icon: 'sliders' },
  { id: 'help', label: 'Help', icon: 'help' },
]

function Menu({ tab }: { tab: Tab }) {
  const ref = useRef<HTMLDivElement>(null)
  // the phone's back gesture closes the menu instead of leaving the board
  useBackLayer(true, () => openMenu(null))
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element
      // dialogs opened from the menu (delete confirmations) aren't "outside"
      if (!ref.current?.contains(t) && !t.closest?.('[data-goosey-toggle], [aria-modal]')) openMenu(null)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[aria-modal]') && openMenu(null)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [])
  return (
    <div className={`${c.popover} ${s.bubble} ${s.menu}`} ref={ref} role="group" aria-label="Goosey" onKeyDown={(e) => e.stopPropagation()}>
      <div className={s.tabs} role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-label={t.label} aria-selected={t.id === tab} className={t.id === tab ? s.on : ''} onClick={() => openMenu(t.id)}>
            <span className={s.tabIcon}>
              <Icon name={t.icon} size={18} />
            </span>
            <span className={s.tabLabel}>{t.label}</span>
          </button>
        ))}
      </div>
      <div className={`${s.page} ${tab === 'chat' ? s.chatPage : ''}`}>
        {tab === 'chat' && <ChatTab />}
        {tab === 'reminders' && <RemindersTab />}
        {tab === 'settings' && <Settings />}
        {tab === 'transfers' && <TransfersTab />}
        {tab === 'help' && <Help />}
      </div>
    </div>
  )
}

/** Reminders made here open this board from their notification. */
function RemindersTab() {
  const { id, store } = useSession()
  return <Reminders board={{ id, name: store.name || getBoards().find((b) => b.id === id)?.name || '' }} />
}

const THEMES: { id: ThemePref; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

function Settings() {
  const ui = useUi()
  const dispatch = useUiDispatch()
  return (
    <>
      <b className={s.sub}>Theme</b>
      <div className={s.segmented} role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => (
          <button key={t.id} role="radio" aria-checked={ui.theme === t.id} className={ui.theme === t.id ? s.on : ''} onClick={() => dispatch({ type: 'theme', theme: t.id })}>
            {t.label}
          </button>
        ))}
      </div>

      <InstallApp />

      <AutoSync />

      <Storage />
    </>
  )
}

/** Only while this browser can install Gooseboard and hasn't. */
function InstallApp() {
  const way = useInstallWay()
  if (way === 'none') return null
  return (
    <>
      <b className={s.sub}>App</b>
      <div className={s.field}>
        <span>Install Gooseboard to open it from your home screen or dock, even offline.</span>
        <button className={s.install} onClick={() => install(way)}>
          Install
        </button>
      </div>
    </>
  )
}

/** How big a file this browser copies in from the board on its own. */
function AutoSync() {
  const max = useSyncExternalStore(subscribeAutoSync, getAutoSyncMax)
  return (
    <>
      <b className={s.sub}>Syncing</b>
      <label className={s.field}>
        <span>Largest file to keep a copy of</span>
        <select value={max} onChange={(e) => setAutoSyncMax(Number(e.target.value))}>
          {[...new Set([...AUTO_SYNC_CHOICES, max])]
            .sort((a, b) => a - b)
            .map((n) => (
              <option key={n} value={n}>
                {n === Infinity ? 'Unlimited' : formatSize(n)}
              </option>
            ))}
        </select>
      </label>
      <p>Smaller files people add are copied into this browser on their own, so they open instantly and stay available when their owner is offline. Bigger ones have a sync button.</p>
    </>
  )
}

function Storage() {
  const { mirror, partial } = useSession()
  useSyncExternalStore(mirror.subscribe, mirror.getVersion)
  useSyncExternalStore(partial.subscribe, partial.getVersion)
  const [usage, setUsage] = useState<number | null>(null)
  const [models, setModels] = useState<number | null>(null)
  const [thumbs, setThumbs] = useState<{ count: number; bytes: number } | null>(null)
  const [previews, setPreviews] = useState<{ count: number; bytes: number } | null>(null)
  const refresh = async () => {
    const est = await navigator.storage?.estimate?.().catch(() => null)
    setUsage(est?.usage ?? null)
    setModels(await cachedModelBytes())
    setThumbs(await thumbStats())
    setPreviews(await previewStats())
  }
  useEffect(() => {
    void refresh()
  }, [])
  const files = mirror.stats()
  const pieces = partial.stats()

  const clearModels = async () => {
    if (!(await confirmDialog({ title: 'Delete the AI models?', message: 'The speech model downloads again the next time you record a voice note.', ok: 'Delete', danger: true }))) return
    // the worker may hold the model on the GPU: stop recording and free it before deleting
    await voice.stop()
    engine.reset()
    await deleteAllModels()
    void refresh()
  }
  const clearFiles = async () => {
    if (!(await confirmDialog({ title: 'Forget synced files?', message: 'Copies of other people’s files kept in this browser are removed. Files you saved to disk stay there. Boards fetch what they need again.', ok: 'Forget', danger: true }))) return
    await mirror.clear()
    void refresh()
  }
  const clearCache = async () => {
    if (!(await confirmDialog({ title: 'Clear the cache?', message: 'Pieces of files fetched from other people (streamed videos, and downloads and syncs not yet finished), the previews and thumbnails of other people’s files shown on boards, and the thumbnails of what you share are removed. Synced files stay. Unfinished transfers start over, and previews are fetched or made again when needed.', ok: 'Clear', danger: true }))) return
    await Promise.all([partial.clear(), clearPreviews(), clearThumbs()])
    void refresh()
  }
  const cache = { count: pieces.count + (previews?.count ?? 0) + (thumbs?.count ?? 0), bytes: pieces.bytes + (previews?.bytes ?? 0) + (thumbs?.bytes ?? 0) }

  return (
    <>
      <b className={s.sub}>Storage &amp; data</b>
      {usage !== null && <p>Gooseboard is using {formatSize(usage)} in this browser.</p>}
      <ul className={s.stores}>
        <li title="Speech models downloaded to this browser for voice notes, so they work offline after the first time">
          <span>AI models</span>
          <span className={c.muted}>{models === null ? '…' : models ? formatSize(models) : 'none'}</span>
          <button title="Clear the AI model cache" disabled={!models} onClick={() => void clearModels()}>
            <Icon name="trash" size={13} />
          </button>
        </li>
        <li title="Copies of other people’s files kept in this browser, so they open instantly and stay available when their owner is offline">
          <span>Synced files</span>
          <span className={c.muted}>{files.count ? `${files.count} · ${formatSize(files.bytes)}` : 'none'}</span>
          <button title="Forget synced copies of other people’s files" disabled={!files.count} onClick={() => void clearFiles()}>
            <Icon name="trash" size={13} />
          </button>
        </li>
        <li title="Pieces of files fetched from other people (up to 2 GB), previews of other people’s pictures (no limit), and thumbnails of what you share (up to 256 MB), so transfers resume and boards load quickly and offline">
          <span>Cache</span>
          <span className={c.muted}>{previews === null || thumbs === null ? '…' : cache.count ? formatSize(cache.bytes) : 'none'}</span>
          <button title="Clear the cache" disabled={!cache.count} onClick={() => void clearCache()}>
            <Icon name="trash" size={13} />
          </button>
        </li>
      </ul>
      <p className={c.muted}>Boards themselves are kept in this browser too; delete them from the home screen.</p>
    </>
  )
}

const KEYS: [string, string][] = [
  ['V H P E', 'Select, hand, pen, eraser'],
  ['N F K', 'Note, folder, link'],
  ['M', 'Voice note: start / stop'],
  ['Space + drag', 'Pan'],
  ['Ctrl + wheel', 'Zoom'],
  ['Shift + 1', 'Fit everything'],
  ['Shift + 2', 'Zoom to selection'],
  ['Ctrl + 0 / = / -', 'Zoom 100%, in, out'],
  ['Enter', 'Edit note, open folder, preview file'],
  ['Shift + Enter', 'Note in a big window'],
  ['Ctrl + D', 'Duplicate'],
  ['Ctrl + A', 'Select all'],
  ['Ctrl + Shift + E', 'Export the board as an image'],
  ['Arrows', 'Nudge (Shift for 10px)'],
  ['] / [', 'Bring to front, send to back'],
  ['Ctrl + Z / Y', 'Undo, redo'],
  ['Delete', 'Remove selection'],
  ['Esc', 'Stop editing, back to select'],
]

/** what phones and tablets get instead of the keyboard list */
const TOUCH: [string, string][] = [
  ['Drag', 'Pan the board, or move what’s under your finger'],
  ['Pinch', 'Zoom'],
  ['Two fingers', 'Pan'],
  ['Double-tap', 'New note, or open what’s under your finger'],
  ['Tap again', 'Edit the selected note'],
  ['Hold', 'More options'],
  ['Back', 'Close what’s open, or step out of a folder'],
  ['Hold, then drag', 'Select an area'],
  ['Select more', 'In the bar above a selection: tap items to add them'],
  ['Stylus', 'Draws even under Select; fingers then pan instead'],
]

function Help() {
  const coarse = useCoarse()
  return (
    <>
      <b className={s.sub}>Getting started</b>
      <ul className={s.tips}>
        <li>{coarse ? 'Add files, folders, and links from the toolbar.' : 'Drop or paste files, folders, images, and links anywhere.'}</li>
        <li>Press the mic in the toolbar and talk: what you say is written into a note, live for everyone. Speech is recognised on your device.</li>
        <li>Chat with everyone on the board in the Chat tab; press its mic to say your message instead of typing it.</li>
        <li>Set yourself a reminder, once or repeating, in the Reminders tab. It goes off as a notification while Gooseboard is open.</li>
        <li>{coarse ? 'Hold' : 'Right-click'} anything for more options.</li>
        <li>{coarse ? 'Tap' : 'Click'} someone’s goose in the top right to follow their view.</li>
      </ul>
      <b className={s.sub}>{coarse ? 'Touch' : 'Keyboard'}</b>
      <dl className={s.keys}>
        {(coarse ? TOUCH : KEYS).map(([k, v]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <Diagnostics />
    </>
  )
}

/** Puts `text` on the clipboard; `text` may still be coming, so the copy keeps the click's permission. */
async function copy(text: Promise<string>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })])
      return true
    }
  } catch {
    /* some browsers don't take a promise: try plain text */
  }
  try {
    await navigator.clipboard.writeText(await text)
    return true
  } catch {
    return false
  }
}

/** For bug reports: everything the app knows about itself, and what it's been doing, copied as JSON. */
function Diagnostics() {
  // shown to select by hand when the clipboard refuses
  const [manual, setManual] = useState<string | null>(null)

  const copyAll = async () => {
    const text = collectDiag()
    if (await copy(text)) toast('Diagnostics copied')
    else setManual(await text)
  }

  return (
    <>
      <b className={s.sub}>Diagnostics</b>
      <p className={c.muted}>If something isn’t working, copy these and send them along. They describe this browser, this device, and what Gooseboard has been doing, with names, ids, and everything you wrote left out.</p>
      <div className={s.field}>
        <span />
        <button className={s.install} onClick={() => void copyAll()}>
          Copy diagnostics
        </button>
      </div>
      {manual && <textarea className={s.dump} readOnly value={manual} onFocus={(e) => e.currentTarget.select()} autoFocus />}
    </>
  )
}
