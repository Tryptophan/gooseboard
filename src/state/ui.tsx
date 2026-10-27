import { createContext, useContext, useEffect, useMemo, useReducer, useSyncExternalStore, type Dispatch, type ReactNode } from 'react'
import { getTheme, saveTheme, type ThemePref } from '../lib/storage'
import { PEN_COLORS } from '../model/types'

export type Tool = 'select' | 'hand' | 'pen' | 'highlighter' | 'eraser' | 'note' | 'folder' | 'link'

export interface BrushSettings {
  color: string
  size: number
}

export interface UiState {
  tool: Tool
  selection: string[]
  /** note (or empty link card) currently being edited */
  editing: string | null
  openFolder: string | null
  pen: BrushSettings
  highlighter: BrushSettings
  /** awareness client id being followed */
  follow: number | null
  theme: ThemePref
}

export type UiAction =
  | { type: 'tool'; tool: Tool }
  | { type: 'select'; ids: string[] }
  | { type: 'toggle'; id: string }
  | { type: 'editing'; id: string | null }
  | { type: 'folder'; id: string | null }
  | { type: 'pen'; patch: Partial<BrushSettings> }
  | { type: 'highlighter'; patch: Partial<BrushSettings> }
  | { type: 'follow'; clientId: number | null }
  | { type: 'theme'; theme: ThemePref }
  | { type: 'reset' }

function reducer(s: UiState, a: UiAction): UiState {
  switch (a.type) {
    case 'tool':
      return { ...s, tool: a.tool, editing: null, selection: a.tool === 'select' ? s.selection : [] }
    case 'select':
      return { ...s, selection: a.ids, editing: s.editing && a.ids.includes(s.editing) ? s.editing : null }
    case 'toggle':
      return { ...s, selection: s.selection.includes(a.id) ? s.selection.filter((i) => i !== a.id) : [...s.selection, a.id] }
    case 'editing':
      return { ...s, editing: a.id, selection: a.id ? [a.id] : s.selection }
    case 'folder':
      return { ...s, openFolder: a.id }
    case 'pen':
      return { ...s, pen: { ...s.pen, ...a.patch } }
    case 'highlighter':
      return { ...s, highlighter: { ...s.highlighter, ...a.patch } }
    case 'follow':
      return { ...s, follow: a.clientId }
    case 'theme':
      return { ...s, theme: a.theme }
    case 'reset':
      return { ...s, tool: 'select', selection: [], editing: null, openFolder: null, follow: null }
  }
}

const initial = (): UiState => ({
  tool: 'select',
  selection: [],
  editing: null,
  openFolder: null,
  pen: { color: PEN_COLORS[0], size: 4 },
  highlighter: { color: '#ffd400', size: 8 },
  follow: null,
  theme: getTheme(),
})

const StateCtx = createContext<UiState | null>(null)
const DispatchCtx = createContext<Dispatch<UiAction> | null>(null)

/** Applies the theme to <html> and keeps it in sync with the OS when set to "system". */
export function applyTheme(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')
const subscribeSystemDark = (l: () => void) => {
  const mq = darkQuery()
  mq.addEventListener('change', l)
  return () => mq.removeEventListener('change', l)
}

/** The theme actually shown, and a one-click flip of it (leaves "system" on first use). */
export function useThemeToggle() {
  const { theme } = useUi()
  const dispatch = useUiDispatch()
  const systemDark = useSyncExternalStore(subscribeSystemDark, () => darkQuery().matches)
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  return { dark, toggle: () => dispatch({ type: 'theme', theme: dark ? 'light' : 'dark' }) }
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initial)
  useEffect(() => {
    applyTheme(state.theme)
    saveTheme(state.theme)
    if (state.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const h = () => applyTheme('system')
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [state.theme])
  const d = useMemo(() => dispatch, [])
  return (
    <DispatchCtx.Provider value={d}>
      <StateCtx.Provider value={state}>{children}</StateCtx.Provider>
    </DispatchCtx.Provider>
  )
}

export function useUi(): UiState {
  const s = useContext(StateCtx)
  if (!s) throw new Error('UiProvider missing')
  return s
}
export function useUiDispatch(): Dispatch<UiAction> {
  const d = useContext(DispatchCtx)
  if (!d) throw new Error('UiProvider missing')
  return d
}
