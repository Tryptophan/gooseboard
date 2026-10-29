import { useEffect, useSyncExternalStore } from 'react'

/** Pointer type of the most recent pointerdown anywhere: lets click/contextmenu handlers tell touch from mouse. */
export let lastPointerType = 'mouse'
if (typeof window !== 'undefined') window.addEventListener('pointerdown', (e) => (lastPointerType = e.pointerType), true)
export const lastWasTouch = () => lastPointerType === 'touch'

export const LONG_PRESS_MS = 500
/** Finger travel (px) that turns a press into a drag. */
export const SLOP = 8

/** Reactive matchMedia. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (l) => {
      const mq = matchMedia(query)
      mq.addEventListener('change', l)
      return () => mq.removeEventListener('change', l)
    },
    () => matchMedia(query).matches,
  )
}
export const COARSE = '(pointer: coarse)'
export const PHONE = '(max-width: 720px)'
export const useCoarse = () => useMedia(COARSE)

/**
 * iOS only opens the keyboard for a focus() made inside the user's gesture, and editors mount a
 * render later. Focusing a hidden input now opens it; moving focus on to the editor keeps it open.
 */
let primer: HTMLInputElement | null = null
export function primeKeyboard() {
  if (!lastWasTouch()) return
  if (!primer) {
    primer = document.createElement('input')
    primer.setAttribute('aria-hidden', 'true')
    primer.tabIndex = -1
    // 16px stops iOS zooming in on focus
    primer.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;pointer-events:none'
    document.body.appendChild(primer)
  }
  primer.focus({ preventScroll: true })
  const p = primer
  setTimeout(() => document.activeElement === p && p.blur(), 1500)
}

/**
 * Long-press on touch for elements outside the board (which runs its own gestures). Call from
 * onPointerDown; `fire` gets the press position. Android also sends a native contextmenu for the
 * same press; openMenu drops whichever of the two comes second.
 */
export function longPress(e: { pointerType: string; clientX: number; clientY: number }, fire: (at: { clientX: number; clientY: number }) => void) {
  if (e.pointerType !== 'touch') return
  const at = { clientX: e.clientX, clientY: e.clientY }
  const stop = () => {
    clearTimeout(t)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', stop, true)
    window.removeEventListener('pointercancel', stop, true)
    window.removeEventListener('scroll', stop, true)
  }
  const move = (ev: PointerEvent) => Math.hypot(ev.clientX - at.clientX, ev.clientY - at.clientY) > SLOP && stop()
  const t = setTimeout(() => {
    stop()
    fire(at)
  }, LONG_PRESS_MS)
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', stop, true)
  window.addEventListener('pointercancel', stop, true)
  window.addEventListener('scroll', stop, true)
}

/** Fake event for openMenu from a long-press. */
export const pressEvent = (at: { clientX: number; clientY: number }) => ({ ...at, preventDefault() {}, stopPropagation() {} })

/** Long-press that raises a contextmenu event on the pressed element, so existing onContextMenu handlers serve touch too. */
export function longPressMenu(e: { pointerType: string; clientX: number; clientY: number; target: EventTarget }) {
  const el = e.target as Element
  longPress(e, ({ clientX, clientY }) => el.isConnected && el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY })))
}

/**
 * Keeps the screen on while `on` (a board open on a phone or tablet): the browser lets go of the
 * lock whenever the page is hidden, so it's taken again each time the page comes back.
 */
export function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let dead = false
    const take = async () => {
      if (document.visibilityState !== 'visible' || (lock && !lock.released)) return
      try {
        const l = await navigator.wakeLock.request('screen')
        if (dead) void l.release()
        else lock = l
      } catch {
        /* refused (battery saver, or not a secure page): the screen sleeps as usual */
      }
    }
    void take()
    document.addEventListener('visibilitychange', take)
    return () => {
      dead = true
      document.removeEventListener('visibilitychange', take)
      void lock?.release()
    }
  }, [on])
}
