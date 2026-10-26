// Minimal y-webrtc signaling server for self-hosting.
//   npm run signaling            (PORT=4444 by default)
// Then build the app with VITE_SIGNALING_URLS=ws://localhost:4444 (comma-separated list allowed).
import { WebSocketServer } from 'ws'

const port = Number(process.env.PORT ?? 4444)
const wss = new WebSocketServer({ port })
const PING_MS = 30000
/** @type {Map<string, Set<import('ws').WebSocket>>} */
const topics = new Map()

wss.on('connection', (conn) => {
  /** @type {Set<string>} */
  const subscribed = new Set()
  let alive = true
  conn.on('pong', () => { alive = true })
  const timer = setInterval(() => {
    if (!alive) { conn.terminate(); return }
    alive = false
    try { conn.ping() } catch { conn.close() }
  }, PING_MS)

  const send = (ws, msg) => {
    if (ws.readyState !== ws.OPEN) { ws.close(); return }
    try { ws.send(JSON.stringify(msg)) } catch { ws.close() }
  }

  conn.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (!msg || !msg.type) return
    switch (msg.type) {
      case 'subscribe':
        for (const t of msg.topics ?? []) {
          if (typeof t !== 'string') continue
          if (!topics.has(t)) topics.set(t, new Set())
          topics.get(t).add(conn)
          subscribed.add(t)
        }
        break
      case 'unsubscribe':
        for (const t of msg.topics ?? []) topics.get(t)?.delete(conn)
        break
      case 'publish':
        if (msg.topic) {
          const receivers = topics.get(msg.topic)
          if (receivers) {
            msg.clients = receivers.size
            receivers.forEach((r) => send(r, msg))
          }
        }
        break
      case 'ping':
        send(conn, { type: 'pong' })
        break
    }
  })

  conn.on('close', () => {
    clearInterval(timer)
    subscribed.forEach((t) => {
      const set = topics.get(t)
      if (!set) return
      set.delete(conn)
      if (set.size === 0) topics.delete(t)
    })
  })
})

console.log(`gooseboard signaling server listening on ws://localhost:${port}`)
