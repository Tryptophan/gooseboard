import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { voiceFile, type ChatMessage, type VoiceClip } from '../model/chat'
import { useFileSync, useSession } from '../state/session'
import { loadVolume, saveVolume } from '../lib/media'
import s from './Goosey.module.css'

/** 0:07, 1:32 */
export const clock = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

/** one voice note plays at a time */
let current: HTMLAudioElement | null = null

/**
 * A voice note's play button and waveform. `src` is null until the bytes are here; `status` then
 * says why. Played bars fill in; a click on the waveform jumps there.
 */
export function VoicePlayer({ src, dur, peaks, status }: { src: string | null; dur: number; peaks: number[]; status?: string }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)

  // smooth progress while playing (timeupdate is only a few times a second)
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      if (audio.current) setAt(audio.current.currentTime * 1000)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const toggle = () => {
    const el = audio.current
    if (!el || !src) return
    if (!el.paused) return el.pause()
    if (current && current !== el) current.pause()
    current = el
    void el.play().catch(() => setPlaying(false))
  }
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audio.current
    if (!el || !src) return
    const r = e.currentTarget.getBoundingClientRect()
    el.currentTime = (Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * dur) / 1000
    setAt(el.currentTime * 1000)
    if (el.paused) toggle()
  }

  const done = Math.min(1, at / (dur || 1))
  return (
    // its own clicks don't open the message's details
    <div className={s.voice} onClick={(e) => e.stopPropagation()}>
      <button className={s.play} disabled={!src} aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
          {playing ? <path d="M3 2h3v10H3zM8 2h3v10H8z" /> : <path d="M3.5 1.8v10.4L12 7z" />}
        </svg>
      </button>
      <div className={s.wave} role="presentation" onClick={seek}>
        {peaks.map((p, i) => (
          <i key={i} className={(i + 0.5) / peaks.length <= done ? s.played : ''} style={{ height: `${Math.max(12, p)}%` }} />
        ))}
      </div>
      <span className={s.dur}>{status ?? clock(playing || at ? at : dur)}</span>
      {src && (
        <audio
          ref={audio}
          src={src}
          preload="metadata"
          onLoadedMetadata={(e) => loadVolume(e.currentTarget)}
          onVolumeChange={(e) => saveVolume(e.currentTarget)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false)
            setAt(0)
          }}
        />
      )}
    </div>
  )
}

/** A voice note in the chat: playable once this browser has it, which it fetches by itself. */
export function VoiceMessage({ m }: { m: ChatMessage & { voice: VoiceClip } }) {
  const { mirror } = useSession()
  const sync = useFileSync()
  const st = sync.stateOf(voiceFile(m))
  const have = st.status === 'synced'
  // the Mirror changes as copies come in; the URL is made once there's one to read
  useSyncExternalStore(mirror.subscribe, mirror.getVersion)
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!have) return
    let url: string | null = null
    let gone = false
    void mirror.get(m.voice.hash).then((b) => {
      if (!b || gone) return
      url = URL.createObjectURL(b)
      setSrc(url)
    })
    return () => {
      gone = true
      if (url) URL.revokeObjectURL(url)
      setSrc(null)
    }
  }, [have, mirror, m.voice.hash])

  const status = src
    ? undefined
    : st.status === 'syncing'
      ? `${Math.round((st.pct ?? 0) * 100)}%`
      : st.status === 'unavailable'
        ? 'Offline'
        : have
          ? clock(m.voice.dur)
          : '…'
  return (
    <div title={st.status === 'unavailable' ? `Plays once ${m.from.name}, or someone who has it, is online` : undefined}>
      <VoicePlayer src={src} dur={m.voice.dur} peaks={m.voice.peaks} status={status} />
    </div>
  )
}
