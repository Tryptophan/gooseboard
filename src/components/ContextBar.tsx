import { clamp, unionBounds } from '../lib/geometry'
import { FOLDER_COLORS, NOTE_COLORS, PEN_COLORS, type Item } from '../model/types'
import { useCamera } from '../state/camera'
import { useSession } from '../state/session'
import { useUiDispatch } from '../state/ui'
import { ColorPicker } from './ColorPicker'
import { Icon } from './Icons'
import s from './Canvas.module.css'

/** Floating actions above the current selection. */
export function ContextBar({ items }: { items: Item[] }) {
  const { store } = useSession()
  const dispatch = useUiDispatch()
  const { cam, size } = useCamera()
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

  const left = clamp((b.x + b.w / 2) * cam.z + cam.x, 150, Math.max(150, size.w - 150))
  // clear of the rotate handle (34px above the item)
  let top = b.y * cam.z + cam.y - (only ? 92 : 54)
  if (top < 70) top = (b.y + b.h) * cam.z + cam.y + (types.has('note') ? 52 : 14)

  return (
    <div className={s.contextBar} style={{ left, top }} data-nodrag>
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
      {only?.type === 'folder' && (
        <button title="Open folder" onClick={() => dispatch({ type: 'folder', id: only.id })}>
          <Icon name="folder" size={17} />
        </button>
      )}
      <button title="Bring to front  ]" onClick={() => store.bringToFront(ids)}>
        <Icon name="front" size={17} />
      </button>
      <button title="Send to back  [" onClick={() => store.sendToBack(ids)}>
        <Icon name="back" size={17} />
      </button>
      <button title="Duplicate  Ctrl+D" onClick={() => dispatch({ type: 'select', ids: store.duplicate(ids) })}>
        <Icon name="copy" size={17} />
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
  )
}
