import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isDownloaded, whisperSpec, type ModelSpec } from '../ai/models'
import { voice } from '../ai/voice'
import { chatLog, type ChatMessage, type Receipt, type Recipient } from '../model/chat'
import { useSession } from '../state/session'
import { Icon } from './Icons'
import { DownloadModal } from './MicButton'
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
        {!list.length && <p className={s.empty}>Chat with everyone on this board. Messages stay with the board, so people who join later see them too.</p>}
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
          className={s.text}
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
          {m.text}
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

function Composer() {
  const { store } = useSession()
  const [text, setText] = useState('')
  // the speech model, before dictating for the first time
  const [speech, setSpeech] = useState<ModelSpec | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const st = useSyncExternalStore(voice.subscribe, voice.getState)
  const dictating = st.phase === 'listening' && st.chat
  const heard = dictating && (st.speaking || voice.waiting(''))

  // grows with what's typed, up to a few lines
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [text])

  // leaving the chat ends dictation
  useEffect(
    () => () => {
      const now = voice.getState()
      if (now.phase === 'listening' && now.chat) void voice.stop()
    },
    [],
  )

  const send = () => {
    const t = text.trim()
    if (!t) return
    if (dictating) void voice.stop()
    chatLog(store).send(t)
    setText('')
  }

  const startDictation = () => void voice.dictate(store, (said) => setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said)))
  const dictate = async () => {
    if (st.phase !== 'idle') return void voice.stop()
    const spec = await whisperSpec()
    if (!(await isDownloaded(spec))) return setSpeech(spec)
    startDictation()
  }

  return (
    <div className={s.composer}>
      <div className={s.typing}>
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={dictating ? 'Listening…' : 'Message'}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button
          className={`${s.mic} ${dictating ? s.micOn : ''} ${heard ? s.micHeard : ''}`}
          aria-pressed={dictating}
          title={dictating ? 'Stop dictating' : 'Dictate: say it, and it’s written here'}
          disabled={st.phase !== 'idle' && !dictating}
          onClick={() => void dictate()}
        >
          <Icon name="mic" size={16} />
        </button>
        <button className={s.install} disabled={!text.trim()} onClick={send}>
          Send
        </button>
      </div>
      {speech && (
        <DownloadModal
          spec={speech}
          onClose={(ok) => {
            setSpeech(null)
            if (ok) startDictation()
          }}
        />
      )}
    </div>
  )
}
