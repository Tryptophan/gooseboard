import { useEffect, useReducer, useState } from 'react'
import { addDropItems, pickDirectory, pickFiles } from '../model/actions'
import { PEN_COLORS } from '../model/types'
import { useCamera } from '../state/camera'
import { useSession } from '../state/session'
import { useUi, useUiDispatch, type Tool } from '../state/ui'
import { ColorPicker } from './ColorPicker'
import { Icon } from './Icons'
import s from './Chrome.module.css'

const TOOLS: { tool: Tool; icon: string; label: string; key: string }[] = [
  { tool: 'select', icon: 'select', label: 'Select', key: 'V' },
  { tool: 'hand', icon: 'hand', label: 'Pan', key: 'H / Space' },
  { tool: 'pen', icon: 'pen', label: 'Pen', key: 'P' },
  { tool: 'highlighter', icon: 'highlighter', label: 'Highlighter', key: 'Shift+P' },
  { tool: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
  { tool: 'note', icon: 'note', label: 'Note', key: 'N' },
  { tool: 'folder', icon: 'folder', label: 'Folder', key: 'F' },
  { tool: 'link', icon: 'link', label: 'Link', key: 'K' },
]

export function Toolbar() {
  const session = useSession()
  const { store } = session
  const ui = useUi()
  const dispatch = useUiDispatch()
  const cam = useCamera()
  const [, rerender] = useReducer((n) => n + 1, 0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const h = () => rerender()
    store.undo.on('stack-item-added', h)
    store.undo.on('stack-item-popped', h)
    store.undo.on('stack-cleared', h)
    return () => {
      store.undo.off('stack-item-added', h)
      store.undo.off('stack-item-popped', h)
      store.undo.off('stack-cleared', h)
    }
  }, [store])

  const addFiles = async () => {
    const items = await pickFiles(true)
    if (!items.length) return
    setBusy(true)
    const ids = await addDropItems(session, items, cam.viewCenter(), null, { avoidOverlap: true })
    setBusy(false)
    dispatch({ type: 'select', ids })
  }
  const addDisk = async () => {
    const it = await pickDirectory()
    if (!it) return
    dispatch({ type: 'select', ids: await addDropItems(session, [it], cam.viewCenter(), null, { avoidOverlap: true }) })
  }

  const brush = ui.tool === 'pen' ? ui.pen : ui.tool === 'highlighter' ? ui.highlighter : null
  const setBrush = (patch: Partial<{ color: string; size: number }>) => dispatch({ type: ui.tool === 'pen' ? 'pen' : 'highlighter', patch })

  return (
    <div className={s.toolbarWrap}>
      {brush && (
        <div className={s.brush}>
          {(ui.tool === 'pen' ? PEN_COLORS : ['#ffd400', '#ff7ab8', '#5ce1e6', '#7be495', '#ff9f43', '#b69cff']).map((c) => (
            <button key={c} className={`${s.swatch} ${brush.color === c ? s.swatchOn : ''}`} style={{ background: c }} onClick={() => setBrush({ color: c })} aria-label={`Color ${c}`} />
          ))}
          <ColorPicker className={`${s.swatch} ${s.rainbow}`} value={brush.color} onChange={(c) => setBrush({ color: c })} />
          <input className={s.range} type="range" min={1} max={ui.tool === 'pen' ? 24 : 16} value={brush.size} onChange={(e) => setBrush({ size: Number(e.target.value) })} title="Size" />
          <span className={s.dotPreview} style={{ width: brush.size * (ui.tool === 'pen' ? 1 : 3) + 2, height: brush.size * (ui.tool === 'pen' ? 1 : 3) + 2, background: brush.color, opacity: ui.tool === 'pen' ? 1 : 0.5 }} />
        </div>
      )}
      <div className={s.toolbar}>
        {TOOLS.map((t) => (
          <button key={t.tool} className={ui.tool === t.tool ? s.on : ''} aria-pressed={ui.tool === t.tool} title={`${t.label}  (${t.key})`} onClick={() => dispatch({ type: 'tool', tool: t.tool })}>
            <Icon name={t.icon} />
          </button>
        ))}
        <span className={s.sep} />
        <button title="Share files from your computer" disabled={busy} onClick={() => void addFiles()}>
          <Icon name="file" />
        </button>
        <button title="Share a folder from your computer (browsed live by others)" onClick={() => void addDisk()}>
          <Icon name="disk" />
        </button>
        <span className={s.sep} />
        <button title="Undo  Ctrl+Z" disabled={!store.undo.canUndo()} onClick={() => store.undo.undo()}>
          <Icon name="undo" />
        </button>
        <button title="Redo  Ctrl+Shift+Z" disabled={!store.undo.canRedo()} onClick={() => store.undo.redo()}>
          <Icon name="redo" />
        </button>
      </div>
    </div>
  )
}
