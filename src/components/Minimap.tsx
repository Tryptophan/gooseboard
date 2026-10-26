import { useMemo, useRef } from 'react'
import { bounds, unionBounds } from '../lib/geometry'
import { useCamera } from '../state/camera'
import { useSnapshot } from '../state/session'
import s from './Chrome.module.css'

const W = 188
const H = 124
const COLORS: Record<string, string> = { note: '#e9c93a', stroke: '#6a7380', file: '#3e63dd', folder: '#f2a33a', link: '#30a46c' }

export function Minimap() {
  const snap = useSnapshot()
  const camApi = useCamera()
  const { cam, size } = camApi
  const drag = useRef(false)

  const view = { x: -cam.x / cam.z, y: -cam.y / cam.z, w: size.w / cam.z, h: size.h / cam.z }
  const world = useMemo(() => {
    const items = unionBounds(snap.canvas)
    const u = items ? { x1: Math.min(items.x, view.x), y1: Math.min(items.y, view.y), x2: Math.max(items.x + items.w, view.x + view.w), y2: Math.max(items.y + items.h, view.y + view.h) } : { x1: view.x, y1: view.y, x2: view.x + view.w, y2: view.y + view.h }
    const pad = Math.max(u.x2 - u.x1, u.y2 - u.y1) * 0.08
    return { x: u.x1 - pad, y: u.y1 - pad, w: u.x2 - u.x1 + pad * 2, h: u.y2 - u.y1 + pad * 2 }
  }, [snap.canvas, view.x, view.y, view.w, view.h])

  const k = Math.min(W / world.w, H / world.h)
  const ox = (W - world.w * k) / 2
  const oy = (H - world.h * k) / 2

  const go = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    camApi.centerOn((e.clientX - r.left - ox) / k + world.x, (e.clientY - r.top - oy) / k + world.y)
  }

  return (
    <svg
      className={s.minimap}
      width={W}
      height={H}
      onPointerDown={(e) => {
        drag.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        go(e)
      }}
      onPointerMove={(e) => drag.current && go(e)}
      onPointerUp={() => (drag.current = false)}
      data-nodrag
    >
      {snap.canvas.map((it) => {
        const b = bounds(it)
        return <rect key={it.id} x={ox + (b.x - world.x) * k} y={oy + (b.y - world.y) * k} width={Math.max(1.5, b.w * k)} height={Math.max(1.5, b.h * k)} fill={it.type === 'note' ? it.color : (COLORS[it.type] ?? '#888')} opacity={0.85} rx={1} />
      })}
      <rect className={s.viewRect} x={ox + (view.x - world.x) * k} y={oy + (view.y - world.y) * k} width={view.w * k} height={view.h * k} />
    </svg>
  )
}
