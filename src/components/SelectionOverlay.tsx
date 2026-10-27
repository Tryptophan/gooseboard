import { embedFor } from '../lib/embed'
import type { Item } from '../model/types'
import { unionBounds } from '../lib/geometry'
import s from './BoardSurface.module.css'

const HANDLES = [
  { id: 'nw', x: 0, y: 0, cur: 'nwse-resize' },
  { id: 'n', x: 0.5, y: 0, cur: 'ns-resize' },
  { id: 'ne', x: 1, y: 0, cur: 'nesw-resize' },
  { id: 'e', x: 1, y: 0.5, cur: 'ew-resize' },
  { id: 'se', x: 1, y: 1, cur: 'nwse-resize' },
  { id: 's', x: 0.5, y: 1, cur: 'ns-resize' },
  { id: 'sw', x: 0, y: 1, cur: 'nesw-resize' },
  { id: 'w', x: 0, y: 0.5, cur: 'ew-resize' },
]

export const isResizable = (it: Item) => it.type === 'note' || it.type === 'stroke' || (it.type === 'link' && !it.card && !!embedFor(it.url))

/** Outlines for every selected item; resize/rotate handles when exactly one is selected. */
export function SelectionOverlay({ items, editing }: { items: Item[]; editing: boolean }) {
  if (!items.length) return null
  const single = items.length === 1 ? items[0] : null
  const group = items.length > 1 ? unionBounds(items) : null
  const tf = (i: Pick<Item, 'x' | 'y' | 'rot' | 'w' | 'h'>) => ({
    transform: `translate(${i.x}px, ${i.y}px) rotate(${i.rot}rad)`,
    width: i.w,
    height: i.h,
  })
  return (
    <>
      {items.map((i) => (
        <div key={i.id} className={s.selBox} style={tf(i)}>
          {single && !editing && (
            <>
              {isResizable(i) && HANDLES.map((h) => <div key={h.id} className={s.handle} data-handle={h.id} style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%`, cursor: h.cur }} />)}
              <div className={s.rotStem} />
              <div className={s.rotHandle} data-handle="rot" />
            </>
          )}
        </div>
      ))}
      {group && <div className={s.groupBox} style={tf({ ...group, rot: 0 })} />}
    </>
  )
}
