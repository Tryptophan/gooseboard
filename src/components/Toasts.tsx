import { useEffect, useState } from 'react'
import { onToast, type ToastMsg } from '../lib/toast'
import s from './Chrome.module.css'

export function Toasts() {
  const [list, setList] = useState<ToastMsg[]>([])
  useEffect(
    () =>
      onToast((t) => {
        setList((l) => [...l.slice(-3), t])
        setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.action ? 9000 : 3800)
      }),
    [],
  )
  if (!list.length) return null
  return (
    <div className={s.toasts} role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={s.toast}>
          {t.text}
          {t.action && (
            <button
              onClick={() => {
                t.action!.run()
                setList((l) => l.filter((x) => x.id !== t.id))
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
