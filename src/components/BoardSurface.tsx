import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import { MAX_ZOOM, MIN_ZOOM } from '../config'
import { bounds, clamp, distToSegment, pointInItem, rectsIntersect, rotate, snapAngle, toLocal, unionBounds, type Rect, type Vec } from '../lib/geometry'
import { isUrl } from '../lib/files'
import { toast } from '../lib/toast'
import { downsample, pointsBounds, strokePath } from '../lib/stroke'
import { normalizeUrl } from '../lib/url'
import { addDropItems, pickFiles, readDrop } from '../model/actions'
import type { ExportedItem } from '../model/board'
import { jsonToFragment } from '../model/noteSchema'
import { DEFAULT_SIZE, FOLDER_COLORS, NOTE_COLORS, type Item, type Presence, type StrokeItem } from '../model/types'
import { useCamera, type Cam } from '../state/camera'
import { useSession, useSnapshot } from '../state/session'
import { useUi, useUiDispatch } from '../state/ui'
import { ContextBar } from './ContextBar'
import { openMenu, type MenuEntry } from './ContextMenu'
import { promptDialog } from './Dialog'
import { canPreview, usePreview } from './Preview'
import { ItemView } from './Items'
import { RemoteLayer } from './RemoteLayer'
import { SelectionOverlay } from './SelectionOverlay'
import s from './BoardSurface.module.css'

type Inter =
  | { kind: 'pan'; sx: number; sy: number; cam: Cam }
  | { kind: 'move'; start: Vec; orig: Map<string, Vec>; ids: string[]; moved: boolean }
  | { kind: 'marquee'; start: Vec; base: string[] }
  | { kind: 'resize'; id: string; handle: string; orig: { x: number; y: number; w: number; h: number; rot: number } }
  | { kind: 'rotate'; id: string; c: Vec; startAngle: number; origRot: number }
  | { kind: 'draw'; points: number[]; tool: 'pen' | 'highlighter' }
  | { kind: 'erase' }
  | { kind: 'pinch'; d0: number; c0: Vec; cam0: Cam }

const CLIP_PREFIX = 'GOOSEBOARD:'
const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], .ProseMirror')

export function BoardSurface() {
  const session = useSession()
  const { store, profile } = session
  const snap = useSnapshot()
  const ui = useUi()
  const dispatch = useUiDispatch()
  const camApi = useCamera()
  const { cam, size } = camApi
  const preview = usePreview()

  const hostRef = useRef<HTMLDivElement>(null)
  const inter = useRef<Inter | null>(null)
  const pointers = useRef(new Map<number, Vec>())
  const lastWorld = useRef<Vec | null>(null)
  const draftRef = useRef<{ points: number[]; color: string; size: number; opacity: number } | null>(null)
  const raf = useRef(0)
  const lastCursorSend = useRef(0)
  const lastDraftSend = useRef(0)

  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [draft, setDraft] = useState<typeof draftRef.current>(null)
  const [moving, setMoving] = useState(false)
  const [spaceDown, setSpaceDown] = useState(false)
  const space = useRef(false)

  // latest values for event handlers (they are bound once)
  const uiRef = useRef(ui)
  uiRef.current = ui
  const snapRef = useRef(snap)
  snapRef.current = snap

  // ---- measuring ----
  useEffect(() => {
    const el = hostRef.current!
    const ro = new ResizeObserver(() => camApi.setSize(el.clientWidth, el.clientHeight))
    ro.observe(el)
    camApi.setSize(el.clientWidth, el.clientHeight)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toWorld = useCallback(
    (e: { clientX: number; clientY: number }): Vec => {
      const r = hostRef.current!.getBoundingClientRect()
      return camApi.screenToWorld(e.clientX - r.left, e.clientY - r.top)
    },
    [camApi],
  )

  const selItems = useMemo(
    () => ui.selection.map((id) => snap.all.get(id)).filter((i): i is Item => !!i && snap.surface.includes(i)),
    [ui.selection, snap],
  )

  // drop selection ids that no longer exist (remote delete / undo)
  useEffect(() => {
    if (ui.selection.some((id) => !snap.all.has(id))) dispatch({ type: 'select', ids: ui.selection.filter((id) => snap.all.has(id)) })
    if (ui.editing && !snap.all.has(ui.editing)) dispatch({ type: 'editing', id: null })
  }, [snap, ui.selection, ui.editing, dispatch])

  // ---- presence ----
  const sendCursor = useCallback(
    (p: Vec | null) => {
      const now = performance.now()
      if (p && now - lastCursorSend.current < 33) return
      lastCursorSend.current = now
      store.setPresence({ cursor: p ? { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 } : null })
    },
    [store],
  )

  const sendDraft = useCallback(
    (d: typeof draftRef.current, force = false) => {
      const now = performance.now()
      if (!force && now - lastDraftSend.current < 60) return
      lastDraftSend.current = now
      store.setPresence({ draft: d ? { ...d, points: downsample(d.points) } : null })
    },
    [store],
  )

  useEffect(() => {
    const t = setTimeout(() => {
      const v = camApi.viewCenter()
      store.setPresence({ view: { cx: Math.round(v.x), cy: Math.round(v.y), z: cam.z } })
    }, 120)
    return () => clearTimeout(t)
  }, [cam, size, store, camApi])

  // ---- follow a peer ----
  useEffect(() => {
    if (ui.follow == null) return
    const aw = store.awareness
    let last = ''
    const apply = () => {
      const st = aw.getStates().get(ui.follow!) as Presence | undefined
      if (!st) {
        dispatch({ type: 'follow', clientId: null })
        toast('Stopped following: they left')
        return
      }
      if (!st.view) return
      const key = `${st.view.cx},${st.view.cy},${st.view.z}`
      if (key === last) return
      last = key
      camApi.centerOn(st.view.cx, st.view.cy, st.view.z)
    }
    apply()
    aw.on('change', apply)
    return () => aw.off('change', apply)
  }, [ui.follow, store, camApi, dispatch])

  // ---- wheel: pan, ctrl/pinch zoom ----
  useEffect(() => {
    const el = hostRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const k = e.deltaMode === 1 ? 16 : 1
      dispatch({ type: 'follow', clientId: null })
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect()
        camApi.zoomAt(Math.exp(-e.deltaY * k * 0.01), e.clientX - r.left, e.clientY - r.top)
      } else if (e.shiftKey && !e.deltaX) camApi.panBy(-e.deltaY * k, 0) // mouse wheels: shift scrolls sideways
      else camApi.panBy(-e.deltaX * k, -e.deltaY * k)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [camApi, dispatch])

  // ---- helpers that mutate ----
  const placeItem = useCallback(
    (init: Record<string, any> & { type: Item['type'] }, at: Vec) => {
      const sz = DEFAULT_SIZE[init.type]
      store.undo.stopCapturing()
      return store.add({ ...init, x: Math.round(at.x - sz.w / 2), y: Math.round(at.y - sz.h / 2) })
    },
    [store],
  )

  const eraseAt = useCallback(
    (wp: Vec) => {
      const z = camApi.camRef.current.z
      const hits: string[] = []
      for (const it of snapRef.current.surface) {
        if (it.type !== 'stroke') continue
        const b = bounds(it)
        if (!rectsIntersect({ x: wp.x - 20, y: wp.y - 20, w: 40, h: 40 }, b)) continue
        const l = toLocal(it, wp)
        const sx = it.ow / it.w
        const sy = it.oh / it.h
        const p = { x: l.x * sx, y: l.y * sy }
        const r = (it.size / 2 + 8 / z) * Math.max(sx, sy)
        const pts = it.points
        let hit = false
        for (let i = 0; i + 5 < pts.length && !hit; i += 3) {
          hit = distToSegment(p, { x: pts[i], y: pts[i + 1] }, { x: pts[i + 3], y: pts[i + 4] }) <= r
        }
        if (!hit && pts.length >= 3 && pts.length < 6) hit = Math.hypot(p.x - pts[0], p.y - pts[1]) <= r
        if (hit) hits.push(it.id)
      }
      if (hits.length) store.remove(hits)
    },
    [store, camApi],
  )

  const commitStroke = useCallback(
    (points: number[], tool: 'pen' | 'highlighter') => {
      const u = uiRef.current
      const brush = tool === 'pen' ? u.pen : u.highlighter
      const sz = tool === 'pen' ? brush.size : brush.size * 3
      const pts = points.length === 3 ? [...points, points[0] + 0.01, points[1], points[2]] : points
      const b = pointsBounds(pts)
      const pad = sz
      const ox = b.x1 - pad
      const oy = b.y1 - pad
      const rel: number[] = []
      for (let i = 0; i + 2 < pts.length; i += 3) rel.push(Math.round((pts[i] - ox) * 10) / 10, Math.round((pts[i + 1] - oy) * 10) / 10, Math.round(pts[i + 2] * 100) / 100)
      const w = b.x2 - b.x1 + pad * 2
      const h = b.y2 - b.y1 + pad * 2
      store.undo.stopCapturing()
      store.add({
        type: 'stroke', x: ox, y: oy, w, h, ow: w, oh: h, points: rel,
        color: brush.color, size: sz, opacity: tool === 'highlighter' ? 0.38 : 1,
      } satisfies Omit<StrokeItem, 'id' | 'z' | 'rot' | 'parent'>)
    },
    [store],
  )

  // ---- pointer interaction ----
  const startPinch = () => {
    const [a, b] = [...pointers.current.values()]
    inter.current = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam0: { ...camApi.camRef.current } }
    setDropTarget(null)
    setMoving(false)
    draftRef.current = null
    setDraft(null)
  }

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const host = hostRef.current!
    const u = uiRef.current
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (e.pointerType === 'touch' && pointers.current.size === 2) {
      host.setPointerCapture(e.pointerId)
      return startPinch()
    }
    if (target.closest('button, input, a, textarea, select, [data-nodrag]')) return
    const handleEl = target.closest<HTMLElement>('[data-handle]')
    const id = target.closest<HTMLElement>('[data-item-id]')?.dataset.itemId
    if (u.editing) {
      if (id === u.editing && !handleEl) return // caret/selection inside the editor
      dispatch({ type: 'editing', id: null })
      ;(document.activeElement as HTMLElement | null)?.blur?.()
    }
    const wp = toWorld(e)
    lastWorld.current = wp

    if (e.button === 1 || (e.button === 0 && (space.current || u.tool === 'hand'))) {
      e.preventDefault()
      host.setPointerCapture(e.pointerId)
      dispatch({ type: 'follow', clientId: null })
      inter.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam: { ...camApi.camRef.current } }
      return
    }
    if (e.button !== 0) return

    switch (u.tool) {
      case 'pen':
      case 'highlighter': {
        host.setPointerCapture(e.pointerId)
        const brush = u.tool === 'pen' ? u.pen : u.highlighter
        const pr = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5
        inter.current = { kind: 'draw', tool: u.tool, points: [wp.x, wp.y, pr] }
        draftRef.current = { points: [wp.x, wp.y, pr], color: brush.color, size: u.tool === 'pen' ? brush.size : brush.size * 3, opacity: u.tool === 'highlighter' ? 0.38 : 1 }
        setDraft({ ...draftRef.current })
        return
      }
      case 'eraser':
        host.setPointerCapture(e.pointerId)
        store.undo.stopCapturing()
        inter.current = { kind: 'erase' }
        eraseAt(wp)
        return
      case 'note': {
        const nid = placeItem({ type: 'note', color: NOTE_COLORS[Math.floor(Math.random() * 3)] }, wp)
        dispatch({ type: 'tool', tool: 'select' })
        dispatch({ type: 'editing', id: nid })
        return
      }
      case 'folder': {
        const fid = placeItem({ type: 'folder', mode: 'virtual', name: 'New folder', owner: profile.id, ownerName: profile.name, color: FOLDER_COLORS[0] }, wp)
        dispatch({ type: 'tool', tool: 'select' })
        dispatch({ type: 'select', ids: [fid] })
        dispatch({ type: 'folder', id: fid })
        return
      }
      case 'link': {
        const lid = placeItem({ type: 'link', url: '' }, wp)
        dispatch({ type: 'tool', tool: 'select' })
        dispatch({ type: 'editing', id: lid })
        return
      }
    }

    // select tool
    host.setPointerCapture(e.pointerId)
    const only = u.selection.length === 1 ? snapRef.current.all.get(u.selection[0]) : undefined
    if (handleEl && only) {
      store.undo.stopCapturing()
      const o = { x: only.x, y: only.y, w: only.w, h: only.h, rot: only.rot }
      setMoving(true)
      if (handleEl.dataset.handle === 'rot') {
        const c = { x: o.x + o.w / 2, y: o.y + o.h / 2 }
        inter.current = { kind: 'rotate', id: only.id, c, startAngle: Math.atan2(wp.y - c.y, wp.x - c.x), origRot: o.rot }
      } else inter.current = { kind: 'resize', id: only.id, handle: handleEl.dataset.handle!, orig: o }
      return
    }
    if (id) {
      let sel = u.selection
      if (e.shiftKey) {
        sel = sel.includes(id) ? sel.filter((i) => i !== id) : [...sel, id]
        dispatch({ type: 'select', ids: sel })
        if (!sel.includes(id)) return
      } else if (!sel.includes(id)) {
        sel = [id]
        dispatch({ type: 'select', ids: sel })
      }
      store.undo.stopCapturing()
      const orig = new Map<string, Vec>()
      for (const sid of sel) {
        const it = snapRef.current.all.get(sid)
        if (it) orig.set(sid, { x: it.x, y: it.y })
      }
      inter.current = { kind: 'move', start: wp, orig, ids: sel, moved: false }
      return
    }
    if (!e.shiftKey) dispatch({ type: 'select', ids: [] })
    inter.current = { kind: 'marquee', start: wp, base: e.shiftKey ? u.selection : [] }
  }

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const wp = toWorld(e)
    lastWorld.current = wp
    sendCursor(wp)
    const it = inter.current
    if (!it) return
    const z = camApi.camRef.current.z

    switch (it.kind) {
      case 'pinch': {
        if (pointers.current.size < 2) return
        const [a, b] = [...pointers.current.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
        const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const r = hostRef.current!.getBoundingClientRect()
        const nz = clamp(it.cam0.z * (d / it.d0), MIN_ZOOM, MAX_ZOOM)
        const wx = (it.c0.x - r.left - it.cam0.x) / it.cam0.z
        const wy = (it.c0.y - r.top - it.cam0.y) / it.cam0.z
        camApi.set({ z: nz, x: c.x - r.left - wx * nz, y: c.y - r.top - wy * nz })
        return
      }
      case 'pan':
        camApi.set({ ...it.cam, x: it.cam.x + e.clientX - it.sx, y: it.cam.y + e.clientY - it.sy })
        return
      case 'move': {
        const dx = wp.x - it.start.x
        const dy = wp.y - it.start.y
        if (!it.moved && Math.hypot(dx, dy) * z < 3) return
        if (!it.moved) {
          it.moved = true
          setMoving(true)
        }
        const patches: Record<string, Record<string, number>> = {}
        it.orig.forEach((o, id) => (patches[id] = { x: Math.round(o.x + dx), y: Math.round(o.y + dy) }))
        store.updateMany(patches)
        let target: string | null = null
        const all = snapRef.current
        // ink stays on the board, so a strokes-only selection has nowhere to drop
        const inkOnly = it.ids.every((id) => all.all.get(id)?.type === 'stroke')
        for (let i = inkOnly ? -1 : all.surface.length - 1; i >= 0; i--) {
          const c = all.surface[i]
          if (c.type === 'folder' && c.mode === 'virtual' && !it.ids.includes(c.id) && pointInItem(c, wp)) {
            target = c.id
            break
          }
        }
        setDropTarget(target)
        return
      }
      case 'marquee': {
        const r = { x: Math.min(it.start.x, wp.x), y: Math.min(it.start.y, wp.y), w: Math.abs(wp.x - it.start.x), h: Math.abs(wp.y - it.start.y) }
        setMarquee(r)
        const hit = snapRef.current.surface.filter((c) => rectsIntersect(r, bounds(c))).map((c) => c.id)
        const next = [...new Set([...it.base, ...hit])]
        const cur = uiRef.current.selection
        if (next.length !== cur.length || next.some((id, i) => id !== cur[i])) dispatch({ type: 'select', ids: next })
        return
      }
      case 'resize': {
        const { orig: o, handle } = it
        const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
        const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
        const c0 = { x: o.x + o.w / 2, y: o.y + o.h / 2 }
        const a = rotate({ x: (-sx * o.w) / 2, y: (-sy * o.h) / 2 }, o.rot)
        const A = { x: c0.x + a.x, y: c0.y + a.y }
        const d = rotate({ x: wp.x - A.x, y: wp.y - A.y }, -o.rot)
        const min = 40
        let w = sx ? Math.max(min, sx * d.x) : o.w
        let h = sy ? Math.max(min, sy * d.y) : o.h
        if (e.shiftKey && sx && sy) {
          const k = Math.max(w / o.w, h / o.h)
          w = o.w * k
          h = o.h * k
        }
        const off = rotate({ x: (sx * w) / 2, y: (sy * h) / 2 }, o.rot)
        const c = { x: A.x + off.x, y: A.y + off.y }
        store.update(it.id, { x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2), w: Math.round(w), h: Math.round(h) })
        return
      }
      case 'rotate': {
        let rot = it.origRot + (Math.atan2(wp.y - it.c.y, wp.x - it.c.x) - it.startAngle)
        if (e.shiftKey) rot = snapAngle(rot)
        store.update(it.id, { rot })
        return
      }
      case 'draw': {
        const pts = it.points
        const lx = pts[pts.length - 3]
        const ly = pts[pts.length - 2]
        if (Math.hypot(wp.x - lx, wp.y - ly) * z < 1.5) return
        const pr = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5
        pts.push(wp.x, wp.y, pr)
        draftRef.current = { ...draftRef.current!, points: pts }
        if (!raf.current)
          raf.current = requestAnimationFrame(() => {
            raf.current = 0
            setDraft(draftRef.current ? { ...draftRef.current } : null)
          })
        sendDraft(draftRef.current)
        return
      }
      case 'erase':
        eraseAt(wp)
    }
  }

  const endPointer = (e: RPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    const it = inter.current
    if (!it) return
    if (it.kind === 'pinch') {
      if (pointers.current.size < 2) inter.current = null
      return
    }
    inter.current = null
    try {
      hostRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    switch (it.kind) {
      case 'move':
        if (it.moved && dropTarget) {
          const folder = snapRef.current.all.get(dropTarget)
          const moved = store.reparent(it.ids, dropTarget)
          const left = it.ids.filter((id) => !moved.includes(id))
          dispatch({ type: 'select', ids: left })
          toast(
            `Moved ${moved.length} item${moved.length === 1 ? '' : 's'} into “${folder && folder.type === 'folder' ? folder.name : 'folder'}”` +
              (left.length ? '. Ink stays on the board' : ''),
          )
        }
        setDropTarget(null)
        setMoving(false)
        break
      case 'marquee':
        setMarquee(null)
        break
      case 'resize':
      case 'rotate':
        setMoving(false)
        break
      case 'draw':
        if (e.type !== 'pointercancel') commitStroke(it.points, it.tool)
        draftRef.current = null
        setDraft(null)
        sendDraft(null, true)
        break
    }
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (t.closest('button, input, a, textarea, [data-nodrag], .ProseMirror')) return
    // pointer capture on the host retargets dblclick to the host, so find the item by position
    const id = document
      .elementsFromPoint(e.clientX, e.clientY)
      .map((el) => el.closest<HTMLElement>('[data-item-id]'))
      .find(Boolean)?.dataset.itemId
    const u = uiRef.current
    if (id) {
      const it = snapRef.current.all.get(id)
      if (!it) return
      if (it.type === 'note') dispatch({ type: 'editing', id })
      else if (it.type === 'folder') dispatch({ type: 'folder', id })
      return
    }
    if (u.tool === 'select') {
      const nid = placeItem({ type: 'note', color: NOTE_COLORS[Math.floor(Math.random() * 3)] }, toWorld(e))
      dispatch({ type: 'editing', id: nid })
    }
  }

  // ---- right-click menu ----
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (isTyping(t)) return // native menu (spellcheck, copy/paste) inside text
    if (t.closest('[data-nodrag]') && !t.closest('[data-item-id]')) return e.preventDefault()
    const at = toWorld(e)
    const id =
      t.closest<HTMLElement>('[data-item-id]')?.dataset.itemId ??
      document.elementsFromPoint(e.clientX, e.clientY).map((el) => el.closest<HTMLElement>('[data-item-id]')).find(Boolean)?.dataset.itemId
    const it = id ? snapRef.current.all.get(id) : undefined
    if (it) {
      const sel = uiRef.current.selection.includes(it.id) ? uiRef.current.selection : [it.id]
      if (sel !== uiRef.current.selection) dispatch({ type: 'select', ids: sel })
      const only = sel.length === 1 ? it : null
      const fileArgs =
        only?.type === 'file'
          ? { ownerId: only.owner, ownerName: only.ownerName, req: { op: 'file', kind: 'file', key: only.key, hash: only.hash } as const, name: only.name, size: only.size, mime: only.mime }
          : null
      const url = only?.type === 'link' ? normalizeUrl(only.url) : null
      const entries: (MenuEntry | false | null | undefined)[] = [
        only?.type === 'note' && { label: 'Edit text', icon: 'note', hint: 'Enter', onSelect: () => dispatch({ type: 'editing', id: only.id }) },
        only?.type === 'note' && { label: 'Open in window', icon: 'expand', hint: 'Shift+Enter', onSelect: () => dispatch({ type: 'noteModal', id: only.id }) },
        only?.type === 'folder' && { label: 'Open', icon: 'folder', hint: 'Enter', onSelect: () => dispatch({ type: 'folder', id: only.id }) },
        only?.type === 'folder' && {
          label: 'Rename…',
          onSelect: async () => {
            const n = await promptDialog({ title: 'Rename folder', value: only.name, ok: 'Rename' })
            if (n) store.update(only.id, { name: n })
          },
        },
        fileArgs && canPreview(fileArgs.name, fileArgs.mime, fileArgs.size) && { label: 'Preview', icon: 'eye', onSelect: () => preview(fileArgs) },
        fileArgs && { label: 'Download', icon: 'download', onSelect: () => void session.files.download(fileArgs) },
        !!url && { label: 'Open link', icon: 'link', onSelect: () => void window.open(url, '_blank', 'noopener,noreferrer') },
        only?.type === 'link' && {
          label: 'Edit link…',
          onSelect: async () => {
            const n = await promptDialog({ title: 'Edit link', value: only.url, placeholder: 'https://…', ok: 'Save' })
            const u = n && normalizeUrl(n)
            if (u) store.update(only.id, { url: u })
            else if (n) toast('Only http(s) links can be added')
          },
        },
        'sep',
        { label: 'Copy', icon: 'copy', hint: 'Ctrl+C', onSelect: () => void writeClip(sel, false) },
        { label: 'Cut', hint: 'Ctrl+X', onSelect: () => void writeClip(sel, true) },
        {
          label: 'Duplicate',
          hint: 'Ctrl+D',
          onSelect: () => {
            store.undo.stopCapturing()
            dispatch({ type: 'select', ids: store.duplicate(sel) })
          },
        },
        'sep',
        { label: 'Bring to front', icon: 'front', hint: ']', onSelect: () => store.bringToFront(sel) },
        { label: 'Send to back', icon: 'back', hint: '[', onSelect: () => store.sendToBack(sel) },
        {
          label: 'Zoom to selection',
          icon: 'fit',
          hint: 'Shift+2',
          onSelect: () => {
            const b = unionBounds(sel.flatMap((i) => snapRef.current.all.get(i) ?? []))
            if (b) camApi.fitRect(b, 120, 2)
          },
        },
        'sep',
        {
          label: sel.length > 1 ? `Delete ${sel.length} items` : 'Delete',
          icon: 'trash',
          hint: 'Del',
          danger: true,
          onSelect: () => {
            store.undo.stopCapturing()
            store.remove(sel)
            dispatch({ type: 'select', ids: [] })
          },
        },
      ]
      return openMenu(e, entries)
    }
    openMenu(e, [
      { label: 'Paste', hint: 'Ctrl+V', onSelect: () => void readClip(at) },
      'sep',
      {
        label: 'Add note here',
        icon: 'note',
        hint: 'N',
        onSelect: () => dispatch({ type: 'editing', id: placeItem({ type: 'note', color: NOTE_COLORS[Math.floor(Math.random() * 3)] }, at) }),
      },
      {
        label: 'Add folder here',
        icon: 'folder',
        hint: 'F',
        onSelect: () => {
          const fid = placeItem({ type: 'folder', mode: 'virtual', name: 'New folder', owner: profile.id, ownerName: profile.name, color: FOLDER_COLORS[0] }, at)
          dispatch({ type: 'select', ids: [fid] })
          dispatch({ type: 'folder', id: fid })
        },
      },
      { label: 'Add link here', icon: 'link', hint: 'K', onSelect: () => dispatch({ type: 'editing', id: placeItem({ type: 'link', url: '' }, at) }) },
      {
        label: 'Add files here…',
        icon: 'file',
        onSelect: async () => {
          const items = await pickFiles(true)
          if (items.length) dispatch({ type: 'select', ids: await addDropItems(session, items, at, null) })
        },
      },
      'sep',
      { label: 'Select all', icon: 'select', hint: 'Ctrl+A', onSelect: () => dispatch({ type: 'select', ids: snapRef.current.surface.map((i) => i.id) }) },
      {
        label: 'Zoom to fit',
        icon: 'fit',
        hint: 'Shift+1',
        disabled: !snapRef.current.surface.length,
        onSelect: () => {
          const b = unionBounds(snapRef.current.surface)
          if (b) camApi.fitRect(b)
        },
      },
    ])
  }

  const writeClip = async (ids: string[], cut: boolean) => {
    try {
      await navigator.clipboard.writeText(clipText(ids))
      afterCopy(ids, cut)
    } catch {
      toast(`Couldn’t reach the clipboard: press Ctrl+${cut ? 'X' : 'C'} instead`)
    }
  }

  const readClip = async (at: Vec) => {
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return toast('Couldn’t read the clipboard: press Ctrl+V instead')
    }
    if (text) pasteText(text, at)
    else toast('Nothing to paste (files paste with Ctrl+V)')
  }

  // ---- OS drag & drop ----
  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    const wp = toWorld(e)
    const pending = readDrop(e.dataTransfer)
    const items = await pending
    if (!items.length) return
    let parent: string | null = null
    for (let i = snapRef.current.surface.length - 1; i >= 0; i--) {
      const c = snapRef.current.surface[i]
      if (c.type === 'folder' && c.mode === 'virtual' && pointInItem(c, wp)) {
        parent = c.id
        break
      }
    }
    const ids = await addDropItems(session, items, wp, parent)
    if (parent) toast(`Added ${ids.length} to the folder`)
    else dispatch({ type: 'select', ids })
  }

  // ---- clipboard (shared by shortcuts and the context menu) ----
  const clipText = useCallback((ids: string[]) => CLIP_PREFIX + JSON.stringify({ v: 1, items: store.exportItems(ids) }), [store])

  const afterCopy = useCallback(
    (ids: string[], cut: boolean) => {
      if (cut) {
        store.undo.stopCapturing()
        store.remove(ids)
        dispatch({ type: 'select', ids: [] })
      } else toast(`Copied ${ids.length} item${ids.length === 1 ? '' : 's'}`)
    },
    [store, dispatch],
  )

  /** Gooseboard items, a link or plain text (as a note), centred on `at`. */
  const pasteText = useCallback(
    (text: string, at: Vec) => {
      if (text.startsWith(CLIP_PREFIX)) {
        let list: ExportedItem[]
        try {
          list = (JSON.parse(text.slice(CLIP_PREFIX.length)) as { items: ExportedItem[] }).items
        } catch {
          return toast('That clipboard content isn’t valid Gooseboard data')
        }
        const roots = list.filter((x) => !x.props.parent || !list.some((o) => o.props.id === x.props.parent))
        const rects = roots.map((r) => ({ x: r.props.x ?? 0, y: r.props.y ?? 0, w: r.props.w ?? 0, h: r.props.h ?? 0, rot: 0 }))
        const b = unionBounds(rects)
        store.undo.stopCapturing()
        const ids = store.importItems(list, b ? at.x - (b.x + b.w / 2) : 0, b ? at.y - (b.y + b.h / 2) : 0)
        dispatch({ type: 'select', ids })
      } else if (isUrl(text)) {
        store.undo.stopCapturing()
        const sz = DEFAULT_SIZE.link
        const id = store.add({ type: 'link', url: text.trim(), x: Math.round(at.x - sz.w / 2), y: Math.round(at.y - sz.h / 2) })
        dispatch({ type: 'select', ids: [id] })
      } else if (text.trim()) {
        const id = placeItem({ type: 'note', color: NOTE_COLORS[0] }, at)
        const f = store.noteFragment(id)
        if (f)
          jsonToFragment(
            { type: 'doc', content: text.split('\n').map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })) },
            f,
          )
        dispatch({ type: 'select', ids: [id] })
      }
    },
    [store, dispatch, placeItem],
  )

  // ---- keyboard + clipboard ----
  useEffect(() => {
    const view = () => camApi.viewCenter()

    const pasteAt = () => lastWorld.current ?? view()

    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (isTyping(e.target)) return
      const ids = uiRef.current.selection
      if (!ids.length) return
      e.clipboardData?.setData('text/plain', clipText(ids))
      e.preventDefault()
      afterCopy(ids, cut)
    }

    // Linux primary-selection paste fires on middle-button release; middle button pans here.
    let middleAt = 0
    const onMiddle = (e: MouseEvent) => {
      if (e.button !== 1) return
      middleAt = performance.now()
      if (e.type !== 'mousedown' && e.type !== 'pointerdown') e.preventDefault()
    }

    const onPaste = async (e: ClipboardEvent) => {
      if (performance.now() - middleAt < 500) return e.preventDefault()
      if (isTyping(e.target)) return
      const cd = e.clipboardData
      if (!cd) return
      e.preventDefault()
      const text = cd.getData('text/plain')
      const files = Array.from(cd.files)
      if (files.length && !text.startsWith(CLIP_PREFIX)) {
        const ids = await addDropItems(session, files.map((file) => ({ kind: 'file' as const, file })), pasteAt(), null, { avoidOverlap: true })
        dispatch({ type: 'select', ids })
      } else pasteText(text, pasteAt())
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (uiRef.current.noteModal) return // the note window owns the keyboard
      const typing = isTyping(e.target)
      if (e.key === 'Escape') {
        if (uiRef.current.editing) {
          dispatch({ type: 'editing', id: null })
          ;(document.activeElement as HTMLElement | null)?.blur?.()
        } else if (uiRef.current.openFolder && !typing) dispatch({ type: 'folder', id: null })
        else if (uiRef.current.tool !== 'select') dispatch({ type: 'tool', tool: 'select' })
        else dispatch({ type: 'select', ids: [] })
        return
      }
      if (typing) return
      const u = uiRef.current
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      const sel = u.selection

      if (e.key === ' ') {
        e.preventDefault()
        if (!space.current) {
          space.current = true
          setSpaceDown(true)
        }
        return
      }
      if (mod) {
        if (k === 'z') {
          e.preventDefault()
          if (e.shiftKey) store.undo.redo()
          else store.undo.undo()
        } else if (k === 'y') {
          e.preventDefault()
          store.undo.redo()
        } else if (k === 'd' && sel.length) {
          e.preventDefault()
          store.undo.stopCapturing()
          dispatch({ type: 'select', ids: store.duplicate(sel) })
        } else if (k === 'a') {
          e.preventDefault()
          dispatch({ type: 'select', ids: snapRef.current.surface.map((i) => i.id) })
        } else if (k === '0') {
          e.preventDefault()
          camApi.zoomTo(1)
        } else if (k === '=' || k === '+') {
          e.preventDefault()
          camApi.zoomTo(camApi.camRef.current.z * 1.25)
        } else if (k === '-') {
          e.preventDefault()
          camApi.zoomTo(camApi.camRef.current.z / 1.25)
        }
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
        e.preventDefault()
        store.undo.stopCapturing()
        store.remove(sel)
        dispatch({ type: 'select', ids: [] })
        return
      }
      if (e.key === 'Enter' && sel.length === 1) {
        const it = snapRef.current.all.get(sel[0])
        if (it?.type === 'note') dispatch(e.shiftKey ? { type: 'noteModal', id: it.id } : { type: 'editing', id: it.id })
        else if (it?.type === 'folder') dispatch({ type: 'folder', id: it.id })
        e.preventDefault()
        return
      }
      if (e.key.startsWith('Arrow') && sel.length) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        store.updateMany(Object.fromEntries(sel.flatMap((id) => { const it = snapRef.current.all.get(id); return it ? [[id, { x: it.x + dx, y: it.y + dy }]] : [] })))
        return
      }
      if (e.key === ']' && sel.length) return store.bringToFront(sel)
      if (e.key === '[' && sel.length) return store.sendToBack(sel)
      if (e.shiftKey && e.key === '!') {
        const b = unionBounds(snapRef.current.surface)
        if (b) camApi.fitRect(b)
        return
      }
      if (e.shiftKey && e.key === '@') {
        const b = unionBounds(sel.flatMap((id) => snapRef.current.all.get(id) ?? []))
        if (b) camApi.fitRect(b, 120, 2)
        return
      }
      const tools: Record<string, typeof u.tool> = { v: 'select', h: 'hand', p: e.shiftKey ? 'highlighter' : 'pen', e: 'eraser', n: 'note', f: 'folder', k: 'link' }
      if (tools[k]) dispatch({ type: 'tool', tool: tools[k] })
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        space.current = false
        setSpaceDown(false)
      }
    }
    const copy = (e: ClipboardEvent) => onCopy(e, false)
    const cut = (e: ClipboardEvent) => onCopy(e, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    document.addEventListener('copy', copy)
    document.addEventListener('cut', cut)
    document.addEventListener('paste', onPaste)
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick'] as const) window.addEventListener(t, onMiddle, true)
    return () => {
      for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick'] as const) window.removeEventListener(t, onMiddle, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('copy', copy)
      document.removeEventListener('cut', cut)
      document.removeEventListener('paste', onPaste)
    }
  }, [store, camApi, dispatch, session, placeItem, pasteText, clipText, afterCopy])

  const cursorClass =
    spaceDown || ui.tool === 'hand' ? s.grab : ui.tool === 'pen' || ui.tool === 'highlighter' || ui.tool === 'eraser' ? s.crosshair : ui.tool === 'select' ? '' : s.place

  const hostStyle = {
    '--z': cam.z,
    '--ox': `${cam.x}px`,
    '--oy': `${cam.y}px`,
  } as CSSProperties

  const childCounts = snap.children
  const hl = draft ? draft.opacity < 1 : false

  return (
    <div
      ref={hostRef}
      data-board-surface
      className={`${s.host} ${cursorClass} ${cam.z < 0.35 ? s.noGrid : ''}`}
      style={hostStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onPointerLeave={() => sendCursor(null)}
      onDoubleClick={onDoubleClick}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
    >
      <div className={s.world} style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }}>
        {snap.surface.map((item) => (
          <ItemView
            key={item.id}
            item={item}
            selected={ui.selection.includes(item.id)}
            dropTarget={dropTarget === item.id}
            editing={ui.editing === item.id}
            childCount={childCounts.get(item.id)?.length ?? 0}
          />
        ))}
        {draft && (
          <svg className={s.draftSvg}>
            <path d={strokePath(draft.points, draft.size, hl, false)} fill={draft.color} opacity={draft.opacity} />
          </svg>
        )}
        <RemoteLayer />
        <SelectionOverlay items={selItems} editing={!!ui.editing} />
        {marquee && <div className={s.marquee} style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
      </div>
      {selItems.length > 0 && !moving && ui.tool === 'select' && <ContextBar items={selItems} />}
      {snap.surface.length === 0 && ui.tool === 'select' && (
        <div className={s.empty}>
          <b>An empty board.</b>
          <span>Double-click to add a note · drop files here · press P to draw · share the link to invite people</span>
        </div>
      )}
    </div>
  )
}

