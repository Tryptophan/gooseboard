import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { lastWasTouch } from '../lib/touch'
import { Icon } from './Icons'
import s from './ContextMenu.module.css'

/** Right-click menus. Call openMenu from an onContextMenu handler; one <MenuHost /> renders it. */
export type MenuEntry =
  | { label: string; icon?: string; hint?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | 'sep'

interface Open {
  x: number
  y: number
  entries: MenuEntry[]
}

let current: Open | null = null
let openedAt = 0
const listeners = new Set<() => void>()
const set = (o: Open | null) => {
  current = o
  listeners.forEach((l) => l())
}

/** Falsy entries are skipped, so conditional items can be written inline. */
export function openMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, entries: (MenuEntry | false | null | undefined)[]) {
  e.preventDefault()
  e.stopPropagation()
  // a touch long-press can open it twice: our timer and Android's native contextmenu
  if (lastWasTouch() && current && performance.now() - openedAt < 1000) return
  // no leading, trailing or doubled separators once conditional entries drop out
  const clean: MenuEntry[] = []
  for (const x of entries) {
    if (!x || (x === 'sep' && (!clean.length || clean[clean.length - 1] === 'sep'))) continue
    clean.push(x)
  }
  if (clean[clean.length - 1] === 'sep') clean.pop()
  if (!clean.length) return
  openedAt = performance.now()
  set({ x: e.clientX, y: e.clientY, entries: clean })
}

export const closeMenu = () => set(null)

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export function MenuHost() {
  const open = useSyncExternalStore(subscribe, () => current)
  return open ? <Menu key={`${open.x},${open.y},${open.entries.length}`} open={open} /> : null
}

function Menu({ open }: { open: Open }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: open.x, top: open.y })
  const [active, setActive] = useState(-1)

  // keep it on screen: flip left/up when it would overflow
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    const left = open.x + r.width > innerWidth - 8 ? Math.max(8, open.x - r.width) : open.x
    const top = open.y + r.height > innerHeight - 8 ? Math.max(8, open.y - r.height) : open.y
    setPos({ left, top })
    ref.current!.focus()
  }, [open])

  useEffect(() => {
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && closeMenu()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('wheel', closeMenu, { passive: true })
    window.addEventListener('resize', closeMenu)
    window.addEventListener('blur', closeMenu)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('wheel', closeMenu)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('blur', closeMenu)
    }
  }, [])

  const items = open.entries.map((x, i) => ({ x, i })).filter((o) => o.x !== 'sep' && !o.x.disabled).map((o) => o.i)
  const pick = (x: MenuEntry) => {
    if (x === 'sep' || x.disabled) return
    closeMenu()
    x.onSelect()
  }

  return (
    <div
      ref={ref}
      className={s.menu}
      style={pos}
      role="menu"
      tabIndex={-1}
      data-nodrag
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        // keep board shortcuts from firing while the menu is open
        e.stopPropagation()
        if (e.key === 'Escape') closeMenu()
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const k = items.indexOf(active)
          const n = e.key === 'ArrowDown' ? (k + 1) % items.length : (k - 1 + items.length) % items.length
          setActive(items[n])
        } else if (e.key === 'Enter' && active >= 0) {
          e.preventDefault()
          pick(open.entries[active])
        }
      }}
    >
      {open.entries.map((x, i) =>
        x === 'sep' ? (
          <div key={i} className={s.sep} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`${x.danger ? s.danger : ''} ${active === i ? s.active : ''}`}
            disabled={x.disabled}
            onPointerEnter={() => setActive(i)}
            onClick={() => pick(x)}
          >
            <span className={s.icon}>{x.icon && <Icon name={x.icon} size={15} />}</span>
            <span className={s.label}>{x.label}</span>
            {x.hint && <span className={s.hint}>{x.hint}</span>}
          </button>
        ),
      )}
    </div>
  )
}
