import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import s from './Tooltip.module.css'

const DELAY_MS = 450
/** moving straight on to the next button shows its tip at once */
const WARM_MS = 600

interface Tip {
  text: string
  rect: DOMRect
}

/**
 * Tooltips for every `title` in the app, drawn by us: the browser's own are slow, skipped
 * over elements that hold pointer capture, and missing on some platforms. On hover an
 * element's title moves to data-tip (so the native one never shows); it keeps an
 * aria-label so screen readers still name icon buttons.
 */
export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let cur: HTMLElement | null = null
    let hiddenAt = 0
    const hide = () => {
      clearTimeout(timer)
      if (cur) hiddenAt = performance.now()
      cur = null
      setTip(null)
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('[title], [data-tip]') ?? null
      if (el === cur) return
      hide()
      if (!el) return
      const title = el.getAttribute('title')
      if (title !== null) {
        el.removeAttribute('title')
        if (title) el.dataset.tip = title
        if (title && !el.hasAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title)
      }
      if (!el.dataset.tip) return
      cur = el
      const show = () => cur === el && el.isConnected && el.dataset.tip && setTip({ text: el.dataset.tip, rect: el.getBoundingClientRect() })
      if (performance.now() - hiddenAt < WARM_MS) show()
      else timer = setTimeout(show, DELAY_MS)
    }
    window.addEventListener('pointerover', over, true)
    window.addEventListener('pointerdown', hide, true)
    window.addEventListener('wheel', hide, { capture: true, passive: true })
    window.addEventListener('keydown', hide, true)
    window.addEventListener('blur', hide)
    document.addEventListener('pointerleave', hide)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerover', over, true)
      window.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('wheel', hide, { capture: true })
      window.removeEventListener('keydown', hide, true)
      window.removeEventListener('blur', hide)
      document.removeEventListener('pointerleave', hide)
    }
  }, [])
  return tip ? <Bubble tip={tip} /> : null
}

function Bubble({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // below the element, centred; above it near the bottom of the screen; kept inside the window
  useLayoutEffect(() => {
    const b = ref.current!.getBoundingClientRect()
    const r = tip.rect
    const left = Math.min(Math.max(8, r.left + r.width / 2 - b.width / 2), innerWidth - b.width - 8)
    const below = r.bottom + 8
    setPos({ left, top: below + b.height > innerHeight - 8 ? r.top - b.height - 8 : below })
  }, [tip])
  return (
    <div ref={ref} className={s.tip} role="tooltip" style={pos ?? { left: 0, top: 0, visibility: 'hidden' }}>
      {tip.text}
    </div>
  )
}
