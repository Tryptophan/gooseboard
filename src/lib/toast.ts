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

export const onToast = (l: L) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export function toast(text: string, action?: ToastMsg['action'], ms?: number) {
  diag('toast', text)
  const t = { id: seq++, text, action, ms }
  listeners.forEach((l) => l(t))
}

/**
 * True when a lazy chunk failed to load because the site was redeployed under this open page
 * (its hashed file is gone): Chrome, Firefox, and Safari word it differently.
 */
export const isStaleChunk = (e: unknown) =>
  e instanceof TypeError && /dynamically imported module|importing a module script failed/i.test(e.message)
