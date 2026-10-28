import { useSyncExternalStore } from 'react'

/**
 * The installable app: the browser's install prompt (caught early, offered from our own
 * buttons) and updates (a new service worker waits until the person reloads into it).
 */

interface InstallPrompt extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * How this browser installs Gooseboard: `prompt` from a button, or by hand from the browser's
 * own menu (`ios`, `android`: Firefox, `mac`: Safari). `none` when it can't or already has.
 */
export type InstallWay = 'prompt' | 'ios' | 'android' | 'mac' | 'none'

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

let deferred: InstallPrompt | null = null
let installed = false
let waiting: ServiceWorker | null = null

const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true

function manualWay(): InstallWay {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Android/.test(ua) && /Firefox\//.test(ua)) return 'android'
  if (/Macintosh/.test(ua) && /Version\/(1[7-9]|[2-9]\d).*Safari/.test(ua)) return 'mac'
  return 'none'
}

function way(): InstallWay {
  if (installed || standalone()) return 'none'
  return deferred ? 'prompt' : manualWay()
}

/** Call before the first render: the install prompt fires once, early. */
export function initPwa(registration: Promise<ServiceWorkerRegistration | undefined>) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPrompt
    emit()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    installed = true
    emit()
  })
  void registration.then((reg) => reg && watchUpdates(reg))
}

let applying = false

function watchUpdates(reg: ServiceWorkerRegistration) {
  const sw = navigator.serviceWorker
  // without a controller this is the first install, which takes over by itself
  const offer = (w: ServiceWorker) => {
    if (!sw.controller) return
    waiting = w
    emit()
  }
  if (reg.waiting) offer(reg.waiting)
  reg.addEventListener('updatefound', () => {
    const w = reg.installing
    w?.addEventListener('statechange', () => w.state === 'installed' && offer(w))
  })
  sw.addEventListener('controllerchange', () => applying && location.reload())
  // an installed app can stay open for days: look for a new version now and then
  const check = () => void reg.update().catch(() => {})
  setInterval(check, 60 * 60 * 1000)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check())
}

/** Reloads into the waiting version. */
export function applyUpdate() {
  if (!waiting) return location.reload()
  applying = true
  waiting.postMessage('gooseboard-update')
}

/** Shows the browser's install prompt; false if it isn't available (use the manual steps). */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false
  const d = deferred
  deferred = null
  emit()
  await d.prompt()
  return (await d.userChoice).outcome === 'accepted'
}

export const useInstallWay = () => useSyncExternalStore(subscribe, way)
export const useUpdateReady = () => useSyncExternalStore(subscribe, () => waiting !== null)

/** What to do by hand where there's no install prompt. */
export const INSTALL_STEPS: Record<Exclude<InstallWay, 'prompt' | 'none'>, string> = {
  ios: 'Tap the Share button in Safari’s toolbar, then “Add to Home Screen”.',
  android: 'Open Firefox’s menu (⋮), then tap “Add app to Home screen” or “Install”.',
  mac: 'In Safari’s menu bar, choose File › Add to Dock.',
}
