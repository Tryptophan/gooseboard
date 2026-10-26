export interface ToastMsg {
  id: number
  text: string
  action?: { label: string; run: () => void }
}

type L = (t: ToastMsg) => void
const listeners = new Set<L>()
let seq = 1

export const onToast = (l: L) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export function toast(text: string, action?: ToastMsg['action']) {
  const t = { id: seq++, text, action }
  listeners.forEach((l) => l(t))
}
