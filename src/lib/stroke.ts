import { getStroke } from 'perfect-freehand'

/** flat [x, y, pressure, ...] -> SVG path of the variable-width outline */
export function strokePath(points: number[], size: number, highlighter: boolean, last = true): string {
  const pts: number[][] = []
  for (let i = 0; i + 2 < points.length; i += 3) pts.push([points[i], points[i + 1], points[i + 2]])
  if (!pts.length) return ''
  if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1], pts[0][2]])
  const simulate = pts.every((p) => p[2] === 0.5)
  const outline = getStroke(pts, {
    size,
    thinning: highlighter ? 0 : 0.5,
    smoothing: 0.55,
    streamline: 0.5,
    simulatePressure: simulate,
    last,
  })
  if (!outline.length) return ''
  const d = outline.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
      return acc
    },
    ['M', ...outline[0], 'Q'] as (string | number)[],
  )
  d.push('Z')
  return d.join(' ')
}

export function pointsBounds(points: number[]) {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (let i = 0; i + 1 < points.length; i += 3) {
    x1 = Math.min(x1, points[i])
    x2 = Math.max(x2, points[i])
    y1 = Math.min(y1, points[i + 1])
    y2 = Math.max(y2, points[i + 1])
  }
  return { x1, y1, x2, y2 }
}

/** Keep awareness payloads small: at most ~`max` points. */
export function downsample(points: number[], max = 160): number[] {
  const n = points.length / 3
  if (n <= max) return points
  const step = Math.ceil(n / max)
  const out: number[] = []
  for (let i = 0; i < n; i += step) out.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2])
  const li = (n - 1) * 3
  out.push(points[li], points[li + 1], points[li + 2])
  return out
}
