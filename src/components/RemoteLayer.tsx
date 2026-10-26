import { useEffect, useRef, useState } from 'react'
import { strokePath } from '../lib/stroke'
import type { Presence } from '../model/types'
import { useSession } from '../state/session'
import s from './Canvas.module.css'

interface Remote {
  clientId: number
  name: string
  color: string
}

/**
 * Other people's cursors and in-progress strokes, drawn inside the world layer.
 * Cursor positions are smoothed with an exponential lerp in rAF, straight on the DOM
 * (no React renders per mouse move).
 */
export function RemoteLayer() {
  const { store } = useSession()
  const [remotes, setRemotes] = useState<Remote[]>([])
  const [drafts, setDrafts] = useState<{ clientId: number; d: NonNullable<Presence['draft']> }[]>([])
  const els = useRef(new Map<number, HTMLDivElement>())
  const target = useRef(new Map<number, { x: number; y: number } | null>())
  const current = useRef(new Map<number, { x: number; y: number }>())

  useEffect(() => {
    const aw = store.awareness
    let lastKey = ''
    const lastDraft = new Map<number, unknown>()
    const read = () => {
      const list: Remote[] = []
      const ds: { clientId: number; d: NonNullable<Presence['draft']> }[] = []
      let draftsChanged = false
      aw.getStates().forEach((raw, clientId) => {
        if (clientId === aw.clientID) return
        const st = raw as Presence
        if (!st.user) return
        list.push({ clientId, name: st.user.name, color: st.user.color })
        target.current.set(clientId, st.cursor)
        if (st.cursor && !current.current.has(clientId)) current.current.set(clientId, { ...st.cursor })
        if (st.draft) ds.push({ clientId, d: st.draft })
        if (lastDraft.get(clientId) !== (st.draft ?? null)) draftsChanged = true
        lastDraft.set(clientId, st.draft ?? null)
      })
      for (const id of [...target.current.keys()]) if (!list.some((r) => r.clientId === id)) {
        target.current.delete(id)
        current.current.delete(id)
        lastDraft.delete(id)
        draftsChanged = true
      }
      const key = JSON.stringify(list)
      if (key !== lastKey) {
        lastKey = key
        setRemotes(list)
      }
      if (draftsChanged) setDrafts(ds)
    }
    read()
    aw.on('change', read)

    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      const k = 1 - Math.exp(-dt / 55)
      els.current.forEach((el, id) => {
        const t = target.current.get(id)
        if (!t) {
          el.style.opacity = '0'
          return
        }
        let c = current.current.get(id)
        if (!c) current.current.set(id, (c = { ...t }))
        c.x += (t.x - c.x) * k
        c.y += (t.y - c.y) * k
        el.style.opacity = '1'
        el.style.transform = `translate(${c.x}px, ${c.y}px)`
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      aw.off('change', read)
      cancelAnimationFrame(raf)
    }
  }, [store])

  return (
    <>
      {drafts.map(({ clientId, d }) => {
        const remote = remotes.find((r) => r.clientId === clientId)
        if (!remote) return null
        const hl = d.opacity < 1
        return (
          <svg key={clientId} className={s.draftSvg}>
            <path d={strokePath(d.points, d.size, hl, false)} fill={d.color} opacity={d.opacity} />
          </svg>
        )
      })}
      {remotes.map((r) => (
        <div
          key={r.clientId}
          className={s.cursor}
          ref={(el) => {
            if (el) els.current.set(r.clientId, el)
            else els.current.delete(r.clientId)
          }}
          style={{ ['--c' as string]: r.color, opacity: 0 }}
        >
          <div className={s.cursorInner}>
            <svg width="18" height="22" viewBox="0 0 18 22">
              <path d="M2 2l13 8-6 1.8L6 18z" fill={r.color} stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span className={s.cursorLabel} style={{ background: r.color }}>
              {r.name}
            </span>
          </div>
        </div>
      ))}
    </>
  )
}
