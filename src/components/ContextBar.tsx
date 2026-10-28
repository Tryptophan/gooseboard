import { useLayoutEffect, useRef, useState } from 'react'
import { embedFor, linkBox } from '../lib/embed'
import { clamp, unionBounds } from '../lib/geometry'
import { FOLDER_COLORS, NOTE_COLORS, PEN_COLORS, type Item } from '../model/types'
import { useCamera } from '../state/camera'
import { useSession } from '../state/session'
import { useCoarse } from '../lib/touch'
import { useUi, useUiDispatch } from '../state/ui'
import { ColorPicker } from './ColorPicker'
import { Icon } from './Icons'
import { NoteToolbar, useBoardNoteEditor } from './Note'
import s from './BoardSurface.module.css'

/** Floating actions above the current selection. */
export function ContextBar({ items }: { items: Item[] }) {
  const { store } = useSession()
  const dispatch = useUiDispatch()
  const { editing, multi } = useUi()
  const noteEditor = useBoardNoteEditor()
  const { cam, size } = useCamera()
  const coarse = useCoarse()
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(300)
  // its width (buttons vary with the selection) keeps it clamped on screen
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth))
    ro.observe(el)
    setWidth(el.offsetWidth)
    return () => ro.disconnect()
  }, [])
  const b = unionBounds(items)
  if (!b) return null
  const ids = items.map((i) => i.id)
  const types = new Set(items.map((i) => i.type))
  const only = items.length === 1 ? items[0] : null

  const palette = types.size === 1 ? (types.has('note') ? NOTE_COLORS : types.has('folder') ? FOLDER_COLORS : types.has('stroke') ? PEN_COLORS : null) : null
  const setColor = (c: string) => {
    store.undo.stopCapturing()
    store.updateMany(Object.fromEntries(ids.map((id) => [id, { color: c }])))
  }

  // onStart/onEnd of one drag come from the same render, so they share this
  let captureTimeout = 0

  const textEditor = only?.type === 'note' && editing === only.id ? noteEditor : null

  const half = width / 2 + 8
  const left = clamp((b.x + b.w / 2) * cam.z + cam.x, half, Math.max(half, size.w - half))
  // bottom edge clears the rotate handle (34px above the item), which is hidden while editing
  const above = b.y * cam.z + cam.y - (only && !editing ? 50 : 12)
  const flip = above - (ref.current?.offsetHeight ?? (textEditor ? 84 : 42)) < 70
  const top = flip ? (b.y + b.h) * cam.z + cam.y + 14 : above

  return (
    <div ref={ref} className={s.contextBar} style={{ left, top, transform: flip ? 'translateX(-50%)' : 'translate(-50%, -100%)' }} data-nodrag>
      {textEditor && only?.type === 'note' && <NoteToolbar editor={textEditor} variant="bare" />}
      <div className={s.contextRow}>
        {palette && (
          <>
            {palette.map((c) => (
              <button key={c} className={s.swatch} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Color ${c}`} />
            ))}
            <ColorPicker
              className={`${s.swatch} ${s.rainbow}`}
              value={(items[0] as { color?: string }).color}
              onChange={(c) => store.updateMany(Object.fromEntries(ids.map((id) => [id, { color: c }])))}
              onStart={() => {
                // one undo step per drag, however long it pauses
                store.undo.stopCapturing()
                captureTimeout = store.undo.captureTimeout
                store.undo.captureTimeout = Infinity
              }}
              onEnd={() => {
                store.undo.captureTimeout = captureTimeout
                store.undo.stopCapturing()
              }}
            />
            <span className={s.sep} />
          </>
        )}
        {only?.type === 'note' && (
          <button title="Open in window  Shift+Enter" onClick={() => dispatch({ type: 'noteModal', id: only.id })}>
            <Icon name="expand" size={17} />
          </button>
        )}
        {only?.type === 'link' && embedFor(only.url) && (
          <button
            title={only.card ? 'Show as embed' : 'Show as card'}
            onClick={() => {
              store.undo.stopCapturing()
              store.update(only.id, { card: !only.card, ...linkBox(only, only.url, !only.card) })
            }}
          >
            <Icon name={only.card ? 'eye' : 'link'} size={17} />
          </button>
        )}
        {only?.type === 'folder' && (
          <button title="Open folder" onClick={() => dispatch({ type: 'folder', id: only.id })}>
            <Icon name="folder" size={17} />
          </button>
        )}
        {coarse && (
          <button className={multi ? s.on : ''} aria-pressed={multi} title="Select more: tap items to add or remove them" onClick={() => dispatch({ type: 'multi', on: !multi })}>
            <Icon name="select" size={17} />
          </button>
        )}
        <button title="Bring to front  ]" onClick={() => store.bringToFront(ids)}>
          <Icon name="front" size={17} />
        </button>
        <button title="Send to back  [" onClick={() => store.sendToBack(ids)}>
          <Icon name="back" size={17} />
        </button>
        <button
          title="Delete  Del"
          className={s.danger}
          onClick={() => {
            store.undo.stopCapturing()
            store.remove(ids)
            dispatch({ type: 'select', ids: [] })
          }}
        >
          <Icon name="trash" size={17} />
        </button>
      </div>
    </div>
  )
}
