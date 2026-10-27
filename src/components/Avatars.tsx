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

export const initial = (name: string) => name.slice(0, 1).toUpperCase() || '?'

export function MoreChip({ hidden, onClick, children }: { hidden: string[]; onClick?: () => void; children?: ReactNode }) {
  return (
    <button className={`${s.avatar} ${s.more}`} title={hidden.join(', ')} onClick={onClick} tabIndex={onClick ? 0 : -1}>
      {children ?? `+${hidden.length}`}
    </button>
  )
}

/** Read-only stack (home screen): who is on a board right now. */
export function AvatarStack({ users, budget }: { users: PresenceUser[]; budget: number }) {
  const n = fitAvatars(users.length, budget)
  return (
    <div className={s.avatars}>
      {users.slice(0, n).map((u) => (
        <span key={u.id} className={`${s.avatar} ${s.static}`} style={{ background: u.color }} title={u.name}>
          {initial(u.name)}
        </span>
      ))}
      {n < users.length && <MoreChip hidden={users.slice(n).map((u) => u.name)} />}
    </div>
  )
}
