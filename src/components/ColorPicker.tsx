import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import s from './ColorPicker.module.css'

type Hsv = { h: number; s: number; v: number }

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function hexToHsv(hex: string): Hsv | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const full = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max }
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
  }
  return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * Rainbow swatch that opens an in-page picker (the native <input type="color">
 * pops a separate OS window on some platforms).
 * onStart/onEnd bracket each drag so callers can group it into one undo step.
 */
export function ColorPicker({
  value,
  onChange,
  onStart,
  onEnd,
  className,
}: {
  value: string | undefined
  onChange: (hex: string) => void
  onStart?: () => void
  onEnd?: () => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [below, setBelow] = useState(false)
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value ?? '') ?? { h: 0, s: 1, v: 1 })
  const [text, setText] = useState(value ?? '')
  const root = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  // follow external changes (preset swatches, peers) without losing hue on greys
  useEffect(() => {
    if (!value || value.toLowerCase() === hsvToHex(hsv)) return
    const next = hexToHsv(value)
    if (next) setHsv(next.s && next.v ? next : { ...next, h: hsv.h })
    setText(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  useLayoutEffect(() => {
    if (!open || !root.current || !pop.current) return
    setBelow(root.current.getBoundingClientRect().top < pop.current.offsetHeight + 16)
  }, [open])

  useEffect(() => {
    if (!open) return
    const h = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', h, true)
    return () => window.removeEventListener('pointerdown', h, true)
  }, [open])

  const set = (next: Hsv) => {
    setHsv(next)
    const hex = hsvToHex(next)
    setText(hex)
    onChange(hex)
  }

  const drag = (e: React.PointerEvent<HTMLDivElement>, apply: (x: number, y: number) => Hsv) => {
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const at = (ev: { clientX: number; clientY: number }) =>
      set(apply(clamp01((ev.clientX - rect.left) / rect.width), clamp01((ev.clientY - rect.top) / rect.height)))
    el.setPointerCapture(e.pointerId)
    onStart?.()
    at(e)
    const move = (ev: PointerEvent) => at(ev)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      onEnd?.()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const commitText = () => {
    const next = hexToHsv(text)
    if (!next) return setText(hsvToHex(hsv))
    onStart?.()
    set(next)
    onEnd?.()
  }

  const hue = `hsl(${hsv.h} 100% 50%)`
  return (
    <div className={s.root} ref={root}>
      <button type="button" className={className} title="More colors…" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <div
          ref={pop}
          className={`${s.pop} ${below ? s.below : ''}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setOpen(false)
            }
          }}
        >
          <div className={s.sv} style={{ backgroundColor: hue }} onPointerDown={(e) => drag(e, (x, y) => ({ h: hsv.h, s: x, v: 1 - y }))}>
            <span className={s.thumb} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
          </div>
          <div className={s.hue} onPointerDown={(e) => drag(e, (x) => ({ ...hsv, h: Math.min(x * 360, 359.9) }))}>
            <span className={s.thumb} style={{ left: `${(hsv.h / 360) * 100}%`, top: '50%', background: hue }} />
          </div>
          <div className={s.row}>
            <span className={s.preview} style={{ background: hsvToHex(hsv) }} />
            <input
              className={s.hex}
              value={text}
              spellCheck={false}
              aria-label="Hex color"
              onChange={(e) => setText(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => e.key === 'Enter' && commitText()}
            />
          </div>
        </div>
      )}
    </div>
  )
}
