/**
 * Goosey, the helper goose in the bottom-left corner: whether his menu is open, and on which
 * tab. A module store (like lib/toast) so anything can open it.
 */

export type Tab = 'chat' | 'settings' | 'transfers' | 'help'

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

// going forward onto a closed menu's entry: nothing to show there, so straight back off it
if (typeof window !== 'undefined')
  window.addEventListener('popstate', () => {
    if (typeof history.state?.goosey === 'number' && !state.menu) history.back()
  })

/** the closed menu's history entry is being taken off (see Goosey's useMenuBackEntry) */
let leaving = false

export function leaveMenuEntry() {
  leaving = true
  window.addEventListener('popstate', () => (leaving = false), { once: true })
  history.back()
}

/** Runs `go` once a closed menu's history entry is off, so that taking it off doesn't undo `go`'s navigation. */
export function afterMenuEntry(go: () => void) {
  if (leaving) window.addEventListener('popstate', () => go(), { once: true })
  else go()
}

export function openMenu(menu: Tab | null) {
  state = { menu }
  listeners.forEach((l) => l())
}
