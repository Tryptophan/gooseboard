/**
 * Goosey, the helper goose in the bottom-left corner: whether his menu is open, and on which
 * tab. A module store (like lib/toast) so anything can open it.
 */

export type Tab = 'settings' | 'transfers' | 'help'

interface State {
  menu: Tab | null
}

let state: State = { menu: null }
const listeners = new Set<() => void>()

export const subscribeGoosey = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
export const getGoosey = () => state

export function openMenu(menu: Tab | null) {
  state = { menu }
  listeners.forEach((l) => l())
}
