import { diag } from './diag'

export interface ToastMsg {
  id: number
  text: string
  action?: { label: string; run: () => void }
  /** how long it stays up, ms */
  ms?: number
}

type L = (t: ToastMsg) => void
const listeners = new Set<L>()
let seq = 1
/** toasts from before anything shows them (a missed reminder, found at startup): handed to the first */
let early: ToastMsg[] = []

export const onToast = (l: L) => {
  listeners.add(l)
  early.forEach(l)
  early = []
  return () => void listeners.delete(l)
}

export function toast(text: string, action?: ToastMsg['action'], ms?: number) {
  diag('toast', text)
  const t = { id: seq++, text, action, ms }
  if (!listeners.size) early.push(t)
  listeners.forEach((l) => l(t))
}

/**
 * True when a lazy chunk failed to load because the site was redeployed under this open page
 * (its hashed file is gone): Chrome, Firefox, and Safari word it differently.
 */
export const isStaleChunk = (e: unknown) =>
  e instanceof TypeError && /dynamically imported module|importing a module script failed/i.test(e.message)
