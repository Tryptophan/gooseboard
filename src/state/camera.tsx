import { createContext, useCallback, useContext, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { MAX_ZOOM, MIN_ZOOM } from '../config'
import { clamp, type Rect, type Vec } from '../lib/geometry'

/** screen = world * z + (x, y) */
export interface Cam {
  x: number
  y: number
  z: number
}

export interface CameraApi {
  cam: Cam
  camRef: MutableRefObject<Cam>
  size: { w: number; h: number }
  sizeRef: MutableRefObject<{ w: number; h: number }>
  setSize(w: number, h: number): void
  set(c: Cam): void
  panBy(dx: number, dy: number): void
  zoomAt(factor: number, sx: number, sy: number): void
  zoomTo(z: number): void
  fitRect(r: Rect, pad?: number, maxZoom?: number): void
  centerOn(wx: number, wy: number, z?: number): void
  screenToWorld(sx: number, sy: number): Vec
  viewCenter(): Vec
}

const Ctx = createContext<CameraApi | null>(null)

export function CameraProvider({ initial, children }: { initial?: Cam | null; children: ReactNode }) {
  const [cam, setCam] = useState<Cam>(initial ?? { x: 0, y: 0, z: 1 })
  const [size, setSizeState] = useState({ w: 1000, h: 700 })
  const camRef = useRef(cam)
  const sizeRef = useRef(size)
  const fresh = useRef(!initial)

  const commit = useCallback((c: Cam) => {
    camRef.current = c
    setCam(c)
  }, [])

  const api = useMemo<Omit<CameraApi, 'cam' | 'size'>>(() => {
    const centerOn = (wx: number, wy: number, z = camRef.current.z) => {
      const { w, h } = sizeRef.current
      commit({ x: w / 2 - wx * z, y: h / 2 - wy * z, z })
    }
    return {
      camRef,
      sizeRef,
      setSize(w, h) {
        sizeRef.current = { w, h }
        setSizeState({ w, h })
        // first measurement with no saved camera: put the origin mid-screen
        if (fresh.current) {
          fresh.current = false
          commit({ x: w / 2, y: h / 2, z: 1 })
        }
      },
      set: commit,
      panBy: (dx, dy) => commit({ ...camRef.current, x: camRef.current.x + dx, y: camRef.current.y + dy }),
      zoomAt(factor, sx, sy) {
        const c = camRef.current
        const z = clamp(c.z * factor, MIN_ZOOM, MAX_ZOOM)
        const k = z / c.z
        commit({ x: sx - (sx - c.x) * k, y: sy - (sy - c.y) * k, z })
      },
      zoomTo(z) {
        const { w, h } = sizeRef.current
        const c = camRef.current
        const nz = clamp(z, MIN_ZOOM, MAX_ZOOM)
        const k = nz / c.z
        commit({ x: w / 2 - (w / 2 - c.x) * k, y: h / 2 - (h / 2 - c.y) * k, z: nz })
      },
      fitRect(r, pad = 80, maxZoom = 1) {
        const { w, h } = sizeRef.current
        const z = clamp(Math.min((w - pad * 2) / Math.max(r.w, 1), (h - pad * 2) / Math.max(r.h, 1)), MIN_ZOOM, maxZoom)
        centerOn(r.x + r.w / 2, r.y + r.h / 2, z)
      },
      centerOn,
      screenToWorld(sx, sy) {
        const c = camRef.current
        return { x: (sx - c.x) / c.z, y: (sy - c.y) / c.z }
      },
      viewCenter() {
        const c = camRef.current
        const { w, h } = sizeRef.current
        return { x: (w / 2 - c.x) / c.z, y: (h / 2 - c.y) / c.z }
      },
    }
  }, [commit])

  const value = useMemo<CameraApi>(() => ({ ...api, cam, size }), [api, cam, size])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useCamera(): CameraApi {
  const c = useContext(Ctx)
  if (!c) throw new Error('CameraProvider missing')
  return c
}
