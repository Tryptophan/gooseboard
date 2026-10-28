import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { engine } from '../ai/engine'
import { cachedModelBytes, deleteAllModels } from '../ai/models'
import { AUTO_SYNC_CHOICES, getAutoSyncMax, setAutoSyncMax, subscribeAutoSync } from '../lib/autoSync'
import { voice } from '../ai/voice'
import { formatSize } from '../lib/files'
import type { ThemePref } from '../lib/storage'
import { useCoarse } from '../lib/touch'
import { useInstallWay } from '../net/pwa'
import { getGoosey, openMenu, subscribeGoosey, type Tab } from '../state/goosey'
import { useSession } from '../state/session'
import { useUi, useUiDispatch } from '../state/ui'
import { confirmDialog } from './Dialog'
import { Icon } from './Icons'
import { install } from './Install'
import { TransfersTab, useTransferProgress } from './TransferPanel'
import c from './Chrome.module.css'
import s from './Goosey.module.css'

const useGoosey = () => useSyncExternalStore(subscribeGoosey, getGoosey)

/** Most-recent pointer position, for Goosey's glances. */
const pointer = { x: -1, y: -1 }

/** Goosey: the helper goose in the bottom-left corner. Click him for settings and help. */
export function Goosey() {
  const { menu } = useGoosey()
  return (
    <div className={s.wrap} data-nodrag>
      {menu && <Menu tab={menu} />}
      <Character open={!!menu} />
      <TransferBadge />
    </div>
  )
}

function Character({ open }: { open: boolean }) {
  const { store } = useSession()
  const ref = useRef<HTMLButtonElement>(null)
  const [look, setLook] = useState(0)
  const [hop, setHop] = useState(false)
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
      aria-label="Goosey: settings and help"
      aria-expanded={open}
      onClick={() => {
        setHop(true)
        openMenu(open ? null : 'settings')
      }}
      onAnimationEnd={(e) => e.animationName.includes('hop') && setHop(false)}
      data-goosey-toggle
    >
      {/* with the menu open he keeps a slight tilt back */}
      <GooseyArt look={look || (open ? -8 : 0)} />
    </button>
  )
}

/** A ring on Goosey's shoulder while files move: how far along, and how many. Opens the Transfers tab. */
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
      <span>{count}</span>
    </button>
  )
}

/** The Gooseboard logo, bigger and alive: the neck sways and glances, the eye blinks. */
function GooseyArt({ look = 0 }: { look?: number }) {
  const neck = 'M22 70V23a9 9 0 0 1 9-9c4 0 7 2 9 4l1 .5V28.5L40 29v41z'
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden className={s.art}>
      <defs>
        <clipPath id="goosey-tile">
          <rect width="64" height="64" rx="14" />
        </clipPath>
      </defs>
      <rect width="64" height="64" rx="14" className={s.tile} />
      <g clipPath="url(#goosey-tile)">
        <g className={s.neck}>
          <g className={s.head} style={{ transform: `rotate(${look}deg)` }}>
            <path d={neck} className={s.white} />
            <path d="M40 18l11 5.5c1 .5 1 1.5 0 2L40 29z" className={s.beak} />
            <circle cx="32" cy="21.5" r="2.2" className={s.eye} />
          </g>
        </g>
      </g>
    </svg>
  )
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'settings', label: 'Settings' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'help', label: 'Help' },
]

function Menu({ tab }: { tab: Tab }) {
  const ref = useRef<HTMLDivElement>(null)
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
          <button key={t.id} role="tab" aria-selected={t.id === tab} className={t.id === tab ? s.on : ''} onClick={() => openMenu(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className={s.page}>
        {tab === 'settings' && <Settings />}
        {tab === 'transfers' && <TransfersTab />}
        {tab === 'help' && <Help />}
      </div>
    </div>
  )
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
  const { mirror } = useSession()
  useSyncExternalStore(mirror.subscribe, mirror.getVersion)
  const [usage, setUsage] = useState<number | null>(null)
  const [models, setModels] = useState<number | null>(null)
  const refresh = async () => {
    const est = await navigator.storage?.estimate?.().catch(() => null)
    setUsage(est?.usage ?? null)
    setModels(await cachedModelBytes())
  }
  useEffect(() => {
    void refresh()
  }, [])
  const files = mirror.stats()

  const clearModels = async () => {
    if (!(await confirmDialog({ title: 'Delete the AI models?', message: 'The speech model downloads again the next time you record a voice note.', ok: 'Delete', danger: true }))) return
    // the worker may hold the model on the GPU: stop recording and free it before deleting
    await voice.stop()
    engine.reset()
    await deleteAllModels()
    void refresh()
  }
  const clearFiles = async () => {
    if (!(await confirmDialog({ title: 'Forget cached files?', message: 'Copies of other people’s files kept in this browser are removed. Files you saved to disk stay there. Boards fetch what they need again.', ok: 'Forget', danger: true }))) return
    await mirror.clear()
    void refresh()
  }

  return (
    <>
      <b className={s.sub}>Storage &amp; data</b>
      {usage !== null && <p>Gooseboard is using {formatSize(usage)} in this browser.</p>}
      <ul className={s.stores}>
        <li>
          <span>AI models</span>
          <span className={c.muted}>{models === null ? '…' : models ? formatSize(models) : 'none'}</span>
          <button title="Clear the AI model cache" disabled={!models} onClick={() => void clearModels()}>
            <Icon name="trash" size={13} />
          </button>
        </li>
        <li>
          <span>Cached files</span>
          <span className={c.muted}>{files.count ? `${files.count} · ${formatSize(files.bytes)}` : 'none'}</span>
          <button title="Forget cached copies of other people’s files" disabled={!files.count} onClick={() => void clearFiles()}>
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
  ['Hold, then drag', 'Select an area'],
  ['Select more', 'In the bar above a selection: tap items to add them'],
  ['Stylus', 'Draws even under Select; fingers then pan instead'],
]

function Help() {
  const coarse = useCoarse()
  return (
    <>
      <p>A simple collaborative decentralized workspace for notes, drawings, files and folders, shared live between browsers. Share the link, and everyone edits together. Files stay on their owner’s device and stream on demand.</p>
      <b className={s.sub}>Getting started</b>
      <ul className={s.tips}>
        <li>{coarse ? 'Add files, folders and links from the toolbar.' : 'Drop or paste files, folders, images and links anywhere.'}</li>
        <li>Press the mic in the toolbar and talk: what you say is written into a note, live for everyone. Speech is recognised on your device.</li>
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
    </>
  )
}
