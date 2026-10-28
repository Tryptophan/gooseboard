import { SMALL_FILE } from '../config'

/**
 * How big a file this browser copies in automatically from the people on a board (per browser,
 * in localStorage). Bigger ones stay put until someone opens, downloads or syncs one.
 */
const KEY = 'gooseboard:autoSyncMax'
const listeners = new Set<() => void>()

let max = (() => {
  try {
    const n = Number(localStorage.getItem(KEY))
    return Number.isFinite(n) && n >= SMALL_FILE ? n : SMALL_FILE
  } catch {
    return SMALL_FILE
  }
})()

export const AUTO_SYNC_CHOICES = [SMALL_FILE, 10 * 1024 * 1024, 50 * 1024 * 1024, 200 * 1024 * 1024, 500 * 1024 * 1024]

export const getAutoSyncMax = () => max
export const subscribeAutoSync = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export function setAutoSyncMax(n: number) {
  max = n
  try {
    localStorage.setItem(KEY, String(n))
  } catch {
    /* private mode: lasts this page */
  }
  listeners.forEach((l) => l())
}
