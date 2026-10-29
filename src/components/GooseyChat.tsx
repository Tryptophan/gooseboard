import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { hashBlob } from '../lib/hash'
import { BARS, record, type Recorded, type Recorder } from '../lib/recorder'
import { toast } from '../lib/toast'
import { chatLog, voiceFile, type ChatMessage, type Receipt, type Recipient, type VoiceClip } from '../model/chat'
import { useSession } from '../state/session'
import { clock, VoiceMessage, VoicePlayer } from './ChatVoice'
import { Icon } from './Icons'
import c from './Chrome.module.css'
import s from './Goosey.module.css'

/** a new name line after this long, even from the same person */
const GAP_MS = 5 * 60_000

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
/** a time, with the day when it isn't today */
const when = (at: number) =>
  new Date(at).toDateString() === new Date().toDateString() ? time(at) : new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** The Chat tab: everyone on the board. */
export function ChatTab() {
  const { store } = useSession()
  const log = chatLog(store)
  const list = useSyncExternalStore(log.subscribe, log.get)
  // who has received and read what: re-rendered as it comes in
  useSyncExternalStore(log.subscribe, log.members)
  const me = store.profile.id
  // the message whose details are open
  const [open, setOpen] = useState<string | null>(null)

  // while it's open, everything in it is seen (and read, once the page is in front)
  useEffect(() => log.markSeen(), [log, list])
  useEffect(() => {
    const vis = () => document.visibilityState === 'visible' && log.markSeen()
    document.addEventListener('visibilitychange', vis)
    return () => document.removeEventListener('visibilitychange', vis)
  }, [log])

  // follow new messages, unless the reader has scrolled up
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [list])

  return (
    <div className={s.chat}>
      <div className={s.log} ref={scroller} onScroll={(e) => (pinned.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 24)}>
        {!list.length && (
          <p className={s.empty}>Chat with everyone on this board, in writing or in voice notes. Messages stay with the board, so people who join later see them too.</p>
        )}
        {list.map((m, i) => {
          const prev = list[i - 1]
          const head = !prev || prev.from.id !== m.from.id || m.at - prev.at > GAP_MS
          const mine = m.from.id === me
          return (
            <Message
              key={m.id}
              m={m}
              mine={mine}
              head={head}
              receipt={mine ? log.receipt(i) : undefined}
              details={open === m.id ? log.recipients(i) : undefined}
              me={me}
              toggle={() => setOpen((o) => (o === m.id ? null : m.id))}
            />
          )
        })}
      </div>
      <Composer />
    </div>
  )
}

const TICK_LABEL: Record<Receipt, string> = { pending: 'Not delivered yet', delivered: 'Delivered', read: 'Read' }

/** On one's own messages: a clock until someone has it, ✓ once someone does, a blue ✓✓ once someone has read it. */
function Tick({ receipt }: { receipt: Receipt }) {
  return (
    <span className={`${s.tick} ${receipt === 'read' ? s.tickRead : ''}`} title={TICK_LABEL[receipt]} aria-label={TICK_LABEL[receipt]}>
      <svg width="16" height="11" viewBox="0 0 16 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {receipt === 'pending' ? (
          <>
            <circle cx="8" cy="5.5" r="4.3" />
            <path d="M8 3.3v2.4l1.5 1" />
          </>
        ) : (
          <>
            <path d={receipt === 'read' ? 'M1 6l2.8 2.8L9.5 2.5' : 'M4 6l2.8 2.8L12.5 2.5'} />
            {receipt === 'read' && <path d="M8.3 7.8l1 1L15 2.5" />}
          </>
        )}
      </svg>
    </span>
  )
}

function Message({
  m,
  mine,
  head,
  receipt,
  details,
  me,
  toggle,
}: {
  m: ChatMessage
  mine: boolean
  head: boolean
  receipt?: Receipt
  details?: Recipient[]
  me: string
  toggle: () => void
}) {
  return (
    <div className={`${s.msg} ${mine ? s.mine : ''}`} title={time(m.at)}>
      {head && (
        <div className={s.who}>
          {!mine && <i style={{ background: m.from.color }} />}
          <b>{mine ? 'You' : m.from.name}</b>
          <span className={c.muted}>{time(m.at)}</span>
        </div>
      )}
      <div className={s.line}>
        {receipt && <Tick receipt={receipt} />}
        {/* click (or hold, on touch) for who has it; not when the click ends a text selection */}
        <div
          className={`${s.text} ${m.voice ? s.voiceText : ''}`}
          role="button"
          tabIndex={0}
          aria-expanded={!!details}
          onClick={() => !getSelection()?.toString() && toggle()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle())}
          onContextMenu={(e) => {
            e.preventDefault()
            toggle()
          }}
        >
          {m.voice ? <VoiceMessage m={m as ChatMessage & { voice: VoiceClip }} /> : m.text}
        </div>
      </div>
      {details && <Details m={m} list={details} me={me} />}
    </div>
  )
}

/** Everyone a message went to: read, delivered, or not yet. */
function Details({ m, list, me }: { m: ChatMessage; list: Recipient[]; me: string }) {
  return (
    <div className={s.details}>
      <span className={c.muted}>Sent {when(m.at)}</span>
      {!list.length && <span className={c.muted}>Nobody else has opened this board yet.</span>}
      {list.map(({ member, delivered, read }) => (
        <div key={member.id} className={s.recipient}>
          <i style={{ background: member.color }} />
          <b>{member.id === me ? 'You' : member.name}</b>
          <span className={read !== undefined ? s.readBy : c.muted}>
            {read !== undefined ? `Read ${when(read)}` : delivered !== undefined ? `Delivered ${when(delivered)}` : 'Not delivered yet'}
          </span>
        </div>
      ))}
    </div>
  )
}

type Rec = { phase: 'idle' } | { phase: 'starting' } | { phase: 'recording'; r: Recorder } | { phase: 'recorded'; clip: Recorded; url: string }

/**
 * The message box. The mic records a voice note: tap to start, tap to stop and hear it back, tap
 * again to record it over; Send sends it (stopping first, if it's still recording).
 */
function Composer() {
  const { store, mirror } = useSession()
  const [text, setText] = useState('')
  const [rec, setRec] = useState<Rec>({ phase: 'idle' })
  const area = useRef<HTMLTextAreaElement>(null)
  // the recording in progress, to stop when the chat closes
  const live = useRef<Recorder | null>(null)
  const seq = useRef(0)
  const voiced = rec.phase !== 'idle'

  // grows with what's typed, up to a few lines; its borders counted, or it scrolls by their width
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    const h = el.scrollHeight + el.offsetHeight - el.clientHeight
    el.style.height = `${Math.min(h, 120)}px`
    el.style.overflowY = h > 120 ? 'auto' : 'hidden'
  }, [text, voiced])

  // leaving the chat throws away a recording in progress
  useEffect(
    () => () => {
      seq.current++
      live.current?.cancel()
    },
    [],
  )
  // a recording heard back is played from here until it's sent or dropped
  useEffect(() => (rec.phase === 'recorded' ? () => URL.revokeObjectURL(rec.url) : undefined), [rec])

  const start = async () => {
    const n = ++seq.current
    setRec({ phase: 'starting' })
    try {
      const r = await record(() => void stop())
      if (n !== seq.current) return r.cancel()
      live.current = r
      setRec({ phase: 'recording', r })
    } catch (e) {
      if (n !== seq.current) return
      setRec({ phase: 'idle' })
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      toast(denied ? 'Gooseboard needs the microphone for voice notes' : `Couldn’t start the microphone: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  /** Stops recording, and keeps it to hear back (or nothing, if it was too short). */
  const stop = async (): Promise<Recorded | null> => {
    const r = live.current
    if (!r) return null
    live.current = null
    const n = ++seq.current
    const clip = await r.stop()
    if (n === seq.current) setRec(clip ? { phase: 'recorded', clip, url: URL.createObjectURL(clip.blob) } : { phase: 'idle' })
    return clip
  }
  const discard = () => {
    seq.current++
    live.current?.cancel()
    live.current = null
    setRec({ phase: 'idle' })
  }
  const mic = () => {
    if (rec.phase === 'recording') return void stop()
    if (rec.phase === 'starting') return discard()
    // again: records over the last one
    void start()
  }

  const sendVoice = async (clip: Recorded) => {
    setRec({ phase: 'idle' })
    try {
      const hash = await hashBlob(clip.blob)
      const v: VoiceClip = { hash, size: clip.blob.size, mime: clip.blob.type, dur: clip.dur, peaks: clip.peaks }
      const name = voiceFile({ id: '', at: Date.now(), from: store.profile, text: '', voice: v }).name
      // kept for good: this browser is where the others get it from
      await mirror.put(hash, { name, mime: v.mime, board: store.id }, { blob: clip.blob }, { persist: true })
      chatLog(store).send('', v)
    } catch (e) {
      toast(`Couldn’t send the voice note: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const send = async () => {
    if (rec.phase === 'recorded') return sendVoice(rec.clip)
    if (rec.phase === 'recording') {
      const clip = await stop()
      return clip && sendVoice(clip)
    }
    const t = text.trim()
    if (!t) return
    chatLog(store).send(t)
    setText('')
  }

  return (
    <div className={s.composer}>
      <div className={s.typing}>
        {rec.phase === 'recording' ? (
          <Recording r={rec.r} onDiscard={discard} />
        ) : rec.phase === 'recorded' ? (
          <div className={s.strip}>
            <button className={s.discard} title="Discard this voice note" aria-label="Discard" onClick={discard}>
              <Icon name="trash" size={16} />
            </button>
            <VoicePlayer src={rec.url} dur={rec.clip.dur} peaks={rec.clip.peaks} />
          </div>
        ) : (
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder={rec.phase === 'starting' ? 'Opening the microphone…' : 'Message'}
            aria-label="Message"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
        )}
        <button
          className={`${s.mic} ${rec.phase === 'recording' ? s.micOn : ''}`}
          aria-pressed={rec.phase === 'recording'}
          title={
            rec.phase === 'recording' ? 'Stop recording, to hear it back' : rec.phase === 'recorded' ? 'Record it again' : 'Record a voice note'
          }
          onClick={mic}
        >
          {rec.phase === 'recording' ? (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          ) : (
            <Icon name="mic" size={16} />
          )}
        </button>
        <button className={s.install} disabled={rec.phase === 'starting' || (!voiced && !text.trim())} onClick={() => void send()}>
          Send
        </button>
      </div>
    </div>
  )
}

/** While recording: how long so far, and the last few seconds of loudness, scrolling by. */
function Recording({ r, onDiscard }: { r: Recorder; onDiscard: () => void }) {
  const [, tick] = useState(0)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      tick((n) => n + 1)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  const levels = r.levels().slice(-BARS)
  return (
    <div className={s.strip}>
      <button className={s.discard} title="Discard this voice note" aria-label="Discard" onClick={onDiscard}>
        <Icon name="trash" size={16} />
      </button>
      <div className={`${s.voice} ${s.recording}`}>
        <span className={s.dot} aria-hidden />
        <div className={s.wave} aria-hidden>
          {Array.from({ length: BARS }, (_, i) => levels[i - (BARS - levels.length)]).map((v, i) => (
            <i key={i} style={{ height: `${Math.max(12, (v ?? 0) * 100)}%`, opacity: v === undefined ? 0.25 : 1 }} />
          ))}
        </div>
        <span className={s.dur} aria-live="off">
          {clock(r.elapsed())}
        </span>
      </div>
    </div>
  )
}
