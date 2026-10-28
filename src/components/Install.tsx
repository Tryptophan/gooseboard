import { applyUpdate, INSTALL_STEPS, promptInstall, useUpdateReady, type InstallWay } from '../net/pwa'
import { confirmDialog } from './Dialog'
import c from './Chrome.module.css'

/** The browser's install prompt where there is one, else the steps for its own menu. */
export function install(way: InstallWay) {
  if (way === 'prompt') void promptInstall()
  else if (way !== 'none') void confirmDialog({ title: 'Install Gooseboard', message: INSTALL_STEPS[way], ok: 'Got it' })
}

/** Offers the waiting new version, on every page. */
export function UpdateBanner() {
  if (!useUpdateReady()) return null
  return (
    <div className={c.update} role="status">
      A new version of Gooseboard is ready
      <button onClick={applyUpdate}>Reload</button>
    </div>
  )
}
