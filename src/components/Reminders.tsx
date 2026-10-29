import { useState, useSyncExternalStore } from 'react'
import { askToNotify, deleteReminder, formatWhen, getReminders, notifyState, REPEATS, saveReminder, subscribeReminders, type Reminder, type Repeat } from '../lib/reminders'
import { Icon } from './Icons'
import s from './Reminders.module.css'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** the week as shown, Monday first */
const WEEK = [1, 2, 3, 4, 5, 6, 0]

const pad = (n: number) => String(n).padStart(2, '0')
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** the top of the next hour */
function soon() {
  const d = new Date()
  d.setHours(d.getHours() + 1, 0, 0, 0)
  return d
}

function repeatLabel(r: Reminder) {
  if (r.repeat === 'weekly') {
    const days = r.days?.length ? r.days : [new Date(r.at).getDay()]
    return `Weekly on ${WEEK.filter((d) => days.includes(d)).map((d) => DAYS[d]).join(', ')}`
  }
  if (r.repeat === 'monthly') return `Monthly on the ${ordinal(new Date(r.at).getDate())}`
  return REPEATS.find((x) => x.id === r.repeat)?.label ?? ''
}
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

/**
 * This browser's reminders, with a form to add and edit them: in Goosey's Reminders tab and on
 * the home screen. `board` is where new ones are made, opened from their notification.
 */
export function Reminders({ board, onOpenBoard }: { board?: Reminder['board']; onOpenBoard?: (id: string) => void }) {
  const list = useSyncExternalStore(subscribeReminders, getReminders)
  const notify = useSyncExternalStore(subscribeReminders, notifyState)
  // the reminder being edited, or 'new'
  const [editing, setEditing] = useState<Reminder | 'new' | null>(null)

  return (
    <div className={s.wrap}>
      {editing ? (
        <Form key={editing === 'new' ? 'new' : editing.id} r={editing === 'new' ? null : editing} board={board} done={() => setEditing(null)} />
      ) : (
        <button className={s.add} onClick={() => setEditing('new')}>
          <Icon name="plus" size={14} /> New reminder
        </button>
      )}
      {notify === 'denied' && <p className={s.note}>Notifications are blocked for Gooseboard, so reminders show inside the app instead. To get them as notifications, allow them in your browser’s site settings.</p>}
      {notify === 'unsupported' && (
        <p className={s.note}>This browser can’t show notifications{/iPhone|iPad/.test(navigator.userAgent) ? ' until Gooseboard is installed to the home screen' : ''}, so reminders show inside the app instead.</p>
      )}
      {list.length > 0 && (
        <ul className={s.list}>
          {list.map((r) => (
            <li key={r.id} className={r.next === null ? s.done : ''}>
              <button className={s.item} onClick={() => setEditing(r)} title="Edit">
                <b>{r.text}</b>
                <span>
                  {r.next === null ? `Done · ${formatWhen(r.at)}` : formatWhen(r.next)}
                  {r.repeat !== 'none' && ` · ${repeatLabel(r)}`}
                </span>
              </button>
              {r.board && onOpenBoard && (
                <button className={s.board} onClick={() => onOpenBoard(r.board!.id)} title="Open its board">
                  {r.board.name || 'Untitled board'}
                </button>
              )}
              <button className={s.del} onClick={() => deleteReminder(r.id)} title="Delete reminder" aria-label="Delete reminder">
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className={s.fine}>Reminders are kept in this browser, just for you. They go off while Gooseboard is open, in a tab or as the app; one that comes due while it’s closed shows the next time you open it.</p>
    </div>
  )
}

function Form({ r, board, done }: { r: Reminder | null; board?: Reminder['board']; done: () => void }) {
  const start = new Date(r ? (r.next ?? r.at) : soon().getTime())
  const [text, setText] = useState(r?.text ?? '')
  const [date, setDate] = useState(dateValue(start))
  const [time, setTime] = useState(timeValue(start))
  const [repeat, setRepeat] = useState<Repeat>(r?.repeat ?? 'none')
  const [days, setDays] = useState<number[]>(r?.days?.length ? r.days : [start.getDay()])

  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const at = new Date(y, mo - 1, d, h, mi).getTime()
  const past = repeat === 'none' && at <= Date.now()
  const ok = text.trim() && Number.isFinite(at) && !past && (repeat !== 'weekly' || days.length > 0)

  const submit = async () => {
    if (!ok) return
    saveReminder({ id: r?.id, text: text.trim(), at, repeat, ...(repeat === 'weekly' && { days }), board: r ? r.board : board })
    done()
    // asked from the click, which is what browsers need to show their prompt
    await askToNotify()
  }

  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <input className={s.text} value={text} onChange={(e) => setText(e.target.value)} placeholder="Remind me to…" maxLength={200} autoFocus aria-label="Reminder" />
      <div className={s.row}>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Date" />
        <input type="time" value={time} onChange={(e) => e.target.value && setTime(e.target.value)} aria-label="Time" />
        <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)} aria-label="Repeat">
          {REPEATS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
      </div>
      {repeat === 'weekly' && (
        <div className={s.days} role="group" aria-label="Days">
          {WEEK.map((wd) => (
            <button
              key={wd}
              type="button"
              aria-pressed={days.includes(wd)}
              className={days.includes(wd) ? s.on : ''}
              onClick={() => setDays((l) => (l.includes(wd) ? l.filter((x) => x !== wd) : [...l, wd]))}
            >
              {DAYS[wd].slice(0, 2)}
            </button>
          ))}
        </div>
      )}
      {past && <p className={s.warn}>That time has already passed.</p>}
      <div className={s.actions}>
        <button type="button" onClick={done}>
          Cancel
        </button>
        <button type="submit" className={s.primary} disabled={!ok}>
          {r ? 'Save' : 'Add reminder'}
        </button>
      </div>
    </form>
  )
}
