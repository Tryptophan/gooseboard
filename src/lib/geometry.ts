import type { Item } from '../model/types'

export interface Vec {
  x: number
  y: number
}
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function rotate(v: Vec, rad: number): Vec {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }
}

export const center = (i: Rect): Vec => ({ x: i.x + i.w / 2, y: i.y + i.h / 2 })

/** World point -> item-local coords (0..w, 0..h), undoing rotation. */
export function toLocal(item: Pick<Item, 'x' | 'y' | 'w' | 'h' | 'rot'>, p: Vec): Vec {
  const c = center(item)
  const r = rotate({ x: p.x - c.x, y: p.y - c.y }, -item.rot)
  return { x: r.x + item.w / 2, y: r.y + item.h / 2 }
}

export function corners(item: Pick<Item, 'x' | 'y' | 'w' | 'h' | 'rot'>): Vec[] {
  const c = center(item)
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const r = rotate({ x: (sx * item.w) / 2, y: (sy * item.h) / 2 }, item.rot)
    return { x: c.x + r.x, y: c.y + r.y }
  })
}

/** Axis-aligned bounds of a rotated item. */
export function bounds(item: Pick<Item, 'x' | 'y' | 'w' | 'h' | 'rot'>): Rect {
  const cs = corners(item)
  const xs = cs.map((c) => c.x)
  const ys = cs.map((c) => c.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export function unionBounds(items: Pick<Item, 'x' | 'y' | 'w' | 'h' | 'rot'>[]): Rect | null {
  if (!items.length) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const it of items) {
    const b = bounds(it)
    x1 = Math.min(x1, b.x)
    y1 = Math.min(y1, b.y)
    x2 = Math.max(x2, b.x + b.w)
    y2 = Math.max(y2, b.y + b.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export const rectsIntersect = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

export const pointInItem = (item: Pick<Item, 'x' | 'y' | 'w' | 'h' | 'rot'>, p: Vec) => {
  const l = toLocal(item, p)
  return l.x >= 0 && l.y >= 0 && l.x <= item.w && l.y <= item.h
}

export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1)
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function snapAngle(rad: number, step = Math.PI / 12) {
  return Math.round(rad / step) * step
}
