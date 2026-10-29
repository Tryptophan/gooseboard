import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isDownloaded, whisperSpec, type ModelSpec } from '../ai/models'
import { voice } from '../ai/voice'
import { chatLog, type ChatMessage } from '../model/chat'
import { useSession } from '../state/session'
import { Icon } from './Icons'
import { DownloadModal } from './MicButton'
import c from './Chrome.module.css'
import s from './Goosey.module.css'

/** a new name line after this long, even from the same person */
const GAP_MS = 5 * 60_000

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** The Chat tab: everyone on the board. */
export function ChatTab() {
  const { store } = useSession()
  const log = chatLog(store)
  const list = useSyncExternalStore(log.subscribe, log.get)
  const me = store.profile.id

  // while it's open, everything in it is seen
  useEffect(() => log.markSeen(), [log, list])

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
          return <Message key={m.id} m={m} mine={m.from.id === me} head={head} />
        })}
      </div>
      <Composer />
    </div>
  )
}

function Message({ m, mine, head }: { m: ChatMessage; mine: boolean; head: boolean }) {
  return (
    <div className={`${s.msg} ${mine ? s.mine : ''}`} title={time(m.at)}>
      {head && (
        <div className={s.who}>
          {!mine && <i style={{ background: m.from.color }} />}
          <b>{mine ? 'You' : m.from.name}</b>
          <span className={c.muted}>{time(m.at)}</span>
        </div>
      )}
      <div className={s.text}>{m.text}</div>
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
