import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import type { PresenceUser } from '../model/types'
import s from './Chrome.module.css'

/** Avatar is 30px wide and overlaps the previous one by 6px. */
const FIRST = 30
const STEP = 24

/** How many of `count` avatars fit in `budget` px, leaving room for a "+N" chip when some don't. */
export function fitAvatars(count: number, budget: number): number {
  if (FIRST + (count - 1) * STEP <= budget) return count
  return Math.max(1, Math.min(count - 1, Math.floor((budget - FIRST - STEP) / STEP) + 1))
}

/** Width of `ref`'s element times `fraction`, kept current as it resizes. */
export function useBudget(ref: RefObject<HTMLElement>, fraction: number): number {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [ref])
  return w * fraction
}

/** The logo's goose, drawn over the user's colour; the beak is a darker shade of it so it shows on every colour. */
export function Goose({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden>
      <path d="M22 70V23a9 9 0 0 1 9-9c4 0 7 2 9 4l11 5.5c1 .5 1 1.5 0 2L40 29v41z" fill="#fff" />
      <path d="M40 18l11 5.5c1 .5 1 1.5 0 2L40 29z" style={{ fill: `color-mix(in srgb, ${color} 55%, black)` }} />
      <circle cx="32" cy="21.5" r="2.2" fill="#1b2a4a" />
    </svg>
  )
}

export function MoreChip({ hidden, onClick, children }: { hidden: string[]; onClick?: () => void; children?: ReactNode }) {
  return (
    <button className={`${s.avatar} ${s.more}`} title={hidden.join(', ')} onClick={onClick} tabIndex={onClick ? 0 : -1} data-more-toggle>
      {children ?? `+${hidden.length}`}
    </button>
  )
}

/** Read-only stack (home screen): who is on a board right now. Spans only, so it can sit inside a button. */
export function AvatarStack({ users, budget }: { users: PresenceUser[]; budget: number }) {
  const n = fitAvatars(users.length, budget)
  const hidden = users.slice(n).map((u) => u.name)
  return (
    <span className={s.avatars}>
      {users.slice(0, n).map((u) => (
        <span key={u.id} className={`${s.avatar} ${s.static}`} style={{ background: u.color }} title={u.name}>
          <Goose color={u.color} />
        </span>
      ))}
      {hidden.length > 0 && (
        <span className={`${s.avatar} ${s.more} ${s.static}`} title={hidden.join(', ')}>
          +{hidden.length}
        </span>
      )}
    </span>
  )
}
