import { useEffect, useRef } from 'react'

/**
 * The phone's back gesture (and the browser's Back) steps out of whatever is open on top, one
 * layer at a time: a menu, dialog, preview, note window, or a folder (and each level inside it).
 * Each open layer has a history entry of its own; closed any other way, its entry is taken back off.
 */
interface Layer {
  id: number
  close: () => void
}

// ids outlive a reload in history: start above any old ones, so those read as gone
let seq = Date.now()
const layers: Layer[] = []
/** opened while a traversal we started is still on its way: pushed once it lands */
const deferred: Layer[] = []
/** ids of our entries, oldest first, as far as this page has seen them */
let entries: number[] = []
let pending = 0
const after: (() => void)[] = []

const current = () => (typeof history.state?.back === 'number' ? (history.state.back as number) : 0)
const live = (id: number) => layers.some((l) => l.id === id)

function go(n: number) {
  pending++
  history.go(-n)
}

function push(l: Layer) {
  // a push drops whatever was forward of here
  const at = entries.indexOf(current())
  entries = [...entries.slice(0, at + 1), l.id]
  layers.push(l)
  history.pushState({ ...history.state, back: l.id }, '')
}

/** Takes the entries of closed layers off the top of history. */
function flush() {
  let i = entries.indexOf(current())
  let n = 0
  while (i >= 0 && !live(entries[i])) {
    n++
    i--
  }
  if (n) go(n)
}

if (typeof window !== 'undefined')
  window.addEventListener('popstate', () => {
    const cur = current()
    for (let i = layers.length - 1; i >= 0; i--) {
      if (layers[i].id <= cur) continue
      const [l] = layers.splice(i, 1)
      l.close()
    }
    if (pending) pending--
    // landed on an entry whose layer is gone (going forward, or one closed beneath another): keep going
    if (cur && !live(cur)) return go(1)
    if (pending) return
    deferred.splice(0).forEach(push)
    after.splice(0).forEach((f) => f())
  })

/** Opens a layer that back closes (calling `close`). Returns its release, for when it closes some other way. */
export function pushLayer(close: () => void): () => void {
  const l: Layer = { id: ++seq, close }
  if (pending) deferred.push(l)
  else push(l)
  return () => {
    const d = deferred.indexOf(l)
    if (d >= 0) return void deferred.splice(d, 1)
    const i = layers.indexOf(l)
    // already gone: back closed it
    if (i < 0) return
    layers.splice(i, 1)
    queueMicrotask(flush)
  }
}

/** Runs `then` once history is back on the page's own entry: every open layer closed, and its entry off. */
export function leaveLayers(then: () => void) {
  for (const l of layers.splice(0).reverse()) l.close()
  deferred.length = 0
  flush()
  if (pending) after.push(then)
  else then()
}

/** A layer for as long as `open` is true; back calls `close`. */
export function useBackLayer(open: boolean, close: () => void) {
  const ref = useRef(close)
  useEffect(() => {
    ref.current = close
  })
  useEffect(() => (open ? pushLayer(() => ref.current()) : undefined), [open])
}

/**
 * Steps through places (folders, or levels inside one) as back entries: each place moved to
 * forward gets one, whose back returns to the place before it (`base`, with no entry of its own,
 * at the bottom). Moving to a place already on the trail drops the ones after it.
 */
export function useBackTrail<T extends string | null>(at: T, base: T, goTo: (place: T) => void) {
  const trail = useRef<{ place: T; release: () => void }[]>([])
  const ref = useRef(goTo)
  useEffect(() => {
    ref.current = goTo
  })
  useEffect(() => {
    const t = trail.current
    const i = at === base ? -1 : t.findIndex((e) => e.place === at)
    if (i >= 0 || at === base) {
      t.splice(i + 1)
        .reverse()
        .forEach((e) => e.release())
      return
    }
    const prev = t.length ? t[t.length - 1].place : base
    t.push({ place: at, release: pushLayer(() => ref.current(prev)) })
  }, [at, base])
  useEffect(
    () => () => {
      trail.current
        .splice(0)
        .reverse()
        .forEach((e) => e.release())
    },
    [],
  )
}
