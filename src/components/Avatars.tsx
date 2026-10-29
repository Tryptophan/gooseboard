import { useEffect, useId, useState, type ReactNode, type RefObject } from 'react'
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

/** The logo's goose, lowered so the top of its head sits two thirds of the way up the circle, drawn over the user's colour, with a yellow beak. */
export function Goose({ color, accessory }: { color: string; accessory?: string }) {
  const clip = useId()
  const head = (
    <>
      <path d="M22 70V23a9 9 0 0 1 9-9c4 0 7 2 9 4l11 5.5c1 .5 1 1.5 0 2L40 29v41z" fill="#fff" />
      <path d="M40 18l11 5.5c1 .5 1 1.5 0 2L40 29z" fill="#ffc53d" />
      <circle cx="32" cy="21.5" r="2.2" fill="#1b2a4a" />
    </>
  )
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" shapeRendering="geometricPrecision" aria-hidden>
      <clipPath id={clip}>
        <rect x="0" y="0" width="64" height="30" />
      </clipPath>
      <g transform="translate(0 7.33)">
        {/* the shadow is cast by the head and accessory only; the neck runs off the circle, so a shadow down both its sides reads as stray lines */}
        <g style={{ filter: 'drop-shadow(0 0.6px 1px rgba(0,0,0,0.35))' }}>
          <g clipPath={`url(#${clip})`}>{head}</g>
          <Accessory kind={accessory} />
        </g>
        {head}
        <Accessory kind={accessory} />
      </g>
    </svg>
  )
}

const ICON_BOX: Record<string, string> = {
  tophat: '18 -4.5 26 26', cowboy: '13.5 -7 35 35', scarf: '18 25.25 26 26', partyhat: '21.25 -2.6 19.5 19.5',
  beanie: '19 -3.5 24 24', crown: '19 -3.5 24 24', bow: '18 20 26 26',
}

/** Just the accessory, cropped to fit a chip; "none" is a slashed circle. */
export function AccessoryIcon({ kind }: { kind: string }) {
  return (
    <svg viewBox={ICON_BOX[kind] ?? '0 0 24 24'} width="100%" height="100%" aria-hidden>
      {kind === 'none' ? (
        <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.55">
          <circle cx="12" cy="12" r="7" />
          <path d="M7 17L17 7" />
        </g>
      ) : (
        <Shape kind={kind} />
      )}
    </svg>
  )
}

/** Drawn over the goose's head (top of the neck at x 22-40, crown at y 14); fixed colours. */
function Accessory({ kind }: { kind?: string }) {
  // hats sit down over the crown rather than perched on it
  const hat = kind === 'tophat' || kind === 'partyhat' || kind === 'beanie' || kind === 'crown' || kind === 'cowboy'
  // the goose faces right, so tilting the hat anticlockwise leans it back
  return <g transform={hat ? `translate(${kind === 'crown' ? -1 : kind === 'partyhat' || kind === 'tophat' ? -1 : kind === 'cowboy' ? -1.5 : kind === 'beanie' ? -1 : 0} ${kind === 'cowboy' ? 1.5 : kind === 'beanie' ? 2 : 2.5}) rotate(-12 31 15)` : kind === 'bow' ? 'translate(0 2.5)' : kind === 'scarf' ? 'translate(0 2)' : undefined}><Shape kind={kind} /></g>
}

function Shape({ kind }: { kind?: string }) {
  switch (kind) {
    case 'tophat':
      return (
        <g>
          <rect x="24.5" y="2" width="13" height="11" rx="1" fill={'#1b2a4a'} />
          <rect x="25.5" y="8.5" width="11" height="2.5" fill={'#e5484d'} />
          <rect x="20" y="12" width="22" height="3.2" rx="1.4" fill={'#1b2a4a'} />
        </g>
      )
    case 'cowboy':
      return (
        <g>
          <path d="M23.5 14L24.5 6Q25 3 28 3.5Q31 5.5 34 3.5Q37 3 37.5 6L38.5 14z" fill={'#b8763a'} />
          <path d="M24 10.6Q31 12.4 38 10.6L38.3 13Q31 14.8 23.7 13z" fill={'#5a3418'} />
          <rect x="15.5" y="12.8" width="31" height="3.4" rx="1.7" fill={'#8f5a2b'} />
        </g>
      )
    case 'scarf':
      return (
        <g>
          <path d="M36 33h5v13a2.5 2.5 0 0 1-5 0z" fill={'#e5484d'} />
          <rect x="20" y="28" width="22" height="8" rx="3.5" fill={'#e5484d'} />
          <path d="M26 28.5v7M32 28.5v7" stroke="#fff" strokeWidth="2" fill="none" />
        </g>
      )
    case 'partyhat':
      return (
        <g>
          <path d="M23.5 15L31 0.5L38.5 15z" fill={'#8e4ec6'} />
          {/* bands follow the cone: ends on its edges, curving round the front */}
          <path d="M28.41 5.5Q31 7.3 33.59 5.5L34.62 7.5Q31 9.3 27.38 7.5z" fill={'#ffd43b'} />
          <path d="M26.34 9.5Q31 11.3 35.66 9.5L36.69 11.5Q31 13.3 25.31 11.5z" fill={'#ffd43b'} />
          <circle cx="31" cy="1.5" r="2.2" fill={'#ffd43b'} />
        </g>
      )
    case 'beanie':
      return (
        <g>
          <path d="M22 13a9 9 0 0 1 18 0z" fill={'#3e63dd'} />
          <rect x="21" y="11.5" width="20" height="4.5" rx="1.8" fill={'#9db4ff'} />
          <circle cx="31" cy="3.2" r="2.8" fill={'#9db4ff'} />
        </g>
      )
    case 'crown':
      return (
        <g>
          <path d="M22.5 14.5L21.5 4l5.5 4.5L31 2l4 6.5L40.5 4l-1 10.5z" fill={'#ffc53d'} />
          <circle cx="31" cy="10" r="1.4" fill={'#e5484d'} />
        </g>
      )
    case 'bow':
      return (
        <g>
          <path d="M31 33L20 28v10z" fill={'#f76bb0'} />
          <path d="M31 33L42 28v10z" fill={'#f76bb0'} />
          <rect x="28.8" y="30.5" width="4.4" height="5" rx="1.4" fill={'#d6409f'} />
        </g>
      )
    default:
      return null
  }
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
          <Goose color={u.color} accessory={u.accessory} />
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
