export type TransferState = 'connecting' | 'active' | 'waiting-owner' | 'waiting-relink' | 'done' | 'error' | 'canceled'

export interface Transfer {
  id: string
  dir: 'down' | 'up'
  name: string
  size: number
  done: number
  state: TransferState
  peerName: string
  error?: string
  startedAt: number
  cancel?: () => void
}

type Listener = () => void

/** Observable list of user-visible file transfers (progress UI). */
export class TransferStore {
  private list: Transfer[] = []
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setTimeout> | null = null

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getSnapshot = () => this.list

  private emit() {
    this.timer = null
    this.list = [...this.list]
    this.listeners.forEach((l) => l())
  }

  add(t: Transfer) {
    this.list = [...this.list.filter((x) => x.id !== t.id), t]
    this.emit()
  }

  /** Progress-only patches are throttled; state changes flush immediately. */
  patch(id: string, p: Partial<Transfer>) {
    const t = this.list.find((x) => x.id === id)
    if (!t) return
    const stateChanged = p.state !== undefined && p.state !== t.state
    Object.assign(t, p)
    if (stateChanged) {
      if (this.timer) clearTimeout(this.timer)
      this.emit()
    } else if (!this.timer) this.timer = setTimeout(() => this.emit(), 120)
  }

  remove(id: string) {
    this.list = this.list.filter((x) => x.id !== id)
    this.emit()
  }

  clearFinished() {
    this.list = this.list.filter((t) => t.state !== 'done' && t.state !== 'error' && t.state !== 'canceled')
    this.emit()
  }
}
