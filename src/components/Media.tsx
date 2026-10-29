import { useEffect, useRef, useState } from 'react'
import { DOWNLOAD_TIP, SYNC_TIP } from '../lib/files'
import { getAutoSyncMax } from '../lib/autoSync'
import { loadVolume, saveVolume, type MediaItem } from '../lib/media'
import type { FileItem } from '../model/types'
import { relink } from '../model/actions'
import { useCoarse } from '../lib/touch'
import { canStream } from '../net/streamSW'
import { useFileSync, useSession, usePeers, useSourcesVersion } from '../state/session'
import { safeThumb, SyncBadge } from './FileCard'
import { Icon } from './Icons'
import { PREVIEW_OPENED, usePreview } from './Preview'
import { TypeIcon } from './TypeIcon'
import s from './Media.module.css'

/** a video that can't stream is held whole in memory to play: only up to this size */
const MAX_BLOB = 200 * 1024 * 1024

const fileReq = (item: FileItem) => ({ op: 'file', kind: 'file', key: item.key, hash: item.hash }) as const

/** Sharp rendition of an image item once it's near the screen; the inline thumbnail until then. */
export function useImageSrc(item: FileItem, want: boolean): string | undefined {
  const { files } = useSession()
  const { online } = usePeers()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!want || url) return
    let dead = false
    void files.imageURL(item.owner, item.key, item.hash).then((u) => !dead && setUrl(u))
    return () => {
      dead = true
    }
    // the owner (or a holder) coming online is a reason to ask again
  }, [files, item.owner, item.key, item.hash, want, url, online])
  return url ?? safeThumb(item.thumb)
}

/** True once the element has come within half a screen of the viewport. */
function useNear() {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || near) return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '50%' })
    io.observe(el)
    return () => io.disconnect()
  }, [near])
  return [ref, near] as const
}

export function ImageBody({ item, selected }: { item: MediaItem; selected: boolean }) {
  const [ref, near] = useNear()
  const src = useImageSrc(item, near)
  return (
    <div ref={ref} className={`${s.media} ${selected ? s.selected : ''}`}>
      {src ? <img className={s.bare} src={src} alt="" draggable={false} /> : <TypeIcon name={item.name} mime={item.mime} />}
      <MediaActions item={item} />
    </div>
  )
}

/** A video on the board: its poster with a play button, then played in place (for this viewer only). */
export function VideoBody({ item, selected }: { item: MediaItem; selected: boolean }) {
  const [playing, setPlaying] = useState(false)
  const poster = safeThumb(item.thumb)
  return (
    <div className={`${s.media} ${selected ? s.selected : ''}`}>
      {playing ? (
        <InlineVideo item={item} poster={poster} />
      ) : (
        <>
          {poster ? <img className={s.bare} src={poster} alt="" draggable={false} /> : <div className={s.blank} />}
          <button className={s.bigPlay} title="Play" onClick={() => setPlaying(true)}>
            <PlayGlyph size={22} />
          </button>
        </>
      )}
      <MediaActions item={item} />
    </div>
  )
}

/** a drawn triangle: the ▶ glyph sits off-centre and turns into an emoji on some platforms */
function PlayGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

/** Where a video plays from: streamed over the data channel where the browser can, else fetched whole. */
function useVideoSrc(item: FileItem) {
  const { files } = useSession()
  const [streamed, setStreamed] = useState(canStream)
  const [url, setUrl] = useState<string | null>(null)
  const [wait, setWait] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    const note = (st: string) => setWait(st === 'waiting-owner' ? `Waiting for ${item.ownerName}…` : st === 'waiting-relink' ? `Waiting for ${item.ownerName} to relink it…` : null)
    if (streamed) {
      const st = files.stream(item.owner, fileReq(item), item.size, item.mime, { name: item.name, peerName: item.ownerName, onState: note })
      setUrl(st.url)
      return () => st.close()
    }
    if (item.size > MAX_BLOB) return void setErr('too big to play here without streaming')
    let dead = false
    let made: string | null = null
    const lease = files.acquire(item.owner, fileReq(item))
    const watch = () => note(lease.fetch.state)
    lease.fetch.watchers.add(watch)
    lease.fetch.result
      .then(({ blob }) => {
        if (dead) return
        // the peer's mime is untrusted: pin it to a video type so nothing else renders here
        made = URL.createObjectURL(blob.type.startsWith('video/') ? blob : new Blob([blob], { type: 'video/mp4' }))
        setWait(null)
        setUrl(made)
      })
      .catch((e: Error) => !dead && setErr(e.message))
    return () => {
      dead = true
      lease.fetch.watchers.delete(watch)
      lease.release()
      if (made) URL.revokeObjectURL(made)
    }
    // the item object changes whenever it moves: only what's fetched matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, item.owner, item.ownerName, item.key, item.hash, item.size, item.mime, streamed])
  // streaming failed: try the whole file once
  const failed = (msg: string) => (streamed && item.size <= MAX_BLOB ? setStreamed(false) : setErr(msg))
  return { url, wait, err, failed }
}

/**
 * The video itself, with the browser's own controls while it plays (the board leaves their strip
 * to the player; the rest of the video still drags). Paused, the controls give way to the play button.
 */
function InlineVideo({ item, poster }: { item: FileItem; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const { url, wait, err, failed } = useVideoSrc(item)
  const coarse = useCoarse()
  const [paused, setPaused] = useState(false)
  // Chrome pauses while the seek bar is dragged and resumes on release: only call it paused
  // once the pointer is up and the video has settled, or the controls vanish mid-scrub
  const pressing = useRef(false)
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined)
  const check = () => {
    clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      const v = ref.current
      if (v && !pressing.current) setPaused(v.paused && !v.seeking)
    }, 250)
  }
  useEffect(() => {
    const up = () => {
      if (!pressing.current) return
      pressing.current = false
      check()
    }
    // opening a preview (another video, a picture, a link) pauses this one, where it is
    const pause = () => ref.current?.pause()
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    window.addEventListener(PREVIEW_OPENED, pause)
    return () => {
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      window.removeEventListener(PREVIEW_OPENED, pause)
      clearTimeout(settle.current)
    }
  }, [])
  return (
    <>
      {url && !err && (
        <video
          ref={ref}
          className={`${s.bare} ${paused ? '' : s.live}`}
          src={url}
          poster={poster}
          autoPlay
          playsInline
          controls={!paused}
          onLoadedMetadata={(e) => loadVolume(e.currentTarget)}
          onVolumeChange={(e) => saveVolume(e.currentTarget)}
          onPointerDown={() => (pressing.current = true)}
          onPlay={() => setPaused(false)}
          onPause={check}
          onSeeked={check}
          onError={(e) => {
            const me = e.currentTarget.error
            failed(me?.code === 3 || me?.code === 4 ? 'this browser can’t play this format' : me?.message || 'playback failed')
          }}
        />
      )}
      {/* Firefox's controls swallow every pointer event on the video: cover all but their strip so it still drags
          (not on touch, where a tap anywhere brings up the controls) */}
      {url && !err && !paused && !coarse && <div className={s.grab} />}
      {(err || wait || !url) && <div className={s.note}>{err ? `Can’t play: ${err}` : (wait ?? 'Loading…')}</div>}
      {url && !err && paused && (
        <button className={s.bigPlay} title="Play" onClick={() => void ref.current?.play().catch(() => {})}>
          <PlayGlyph size={22} />
        </button>
      )}
    </>
  )
}

/** Hover buttons on a picture or video: open it large, download it, or (the owner) relink it. */
function MediaActions({ item }: { item: FileItem }) {
  const session = useSession()
  const { files, profile, sources } = session
  useSourcesVersion()
  const fileSync = useFileSync()
  const sync = fileSync.stateOf(item)
  // small files sync on their own; bigger ones on request
  const canSync = item.size > getAutoSyncMax() && fileSync.canSync(item)
  const preview = usePreview()
  const req = fileReq(item)
  const args = { item, ownerId: item.owner, ownerName: item.ownerName, req, name: item.name, size: item.size, mime: item.mime }
  // a cached copy of my own small file still serves after a reload, so no relink is needed
  const mine = item.owner === profile.id
  const unlinked = mine && !sources.isReady(item.key) && sync.status !== 'synced'
  // nobody online can serve it: opening or downloading would only wait
  const blocked = unlinked || (!mine && sync.status === 'unavailable')
  const why = unlinked ? 'Re-select the file first' : `${item.ownerName} is offline and nobody online has a copy`
  return (
    <>
      <div className={`${s.syncSlot} ${blocked ? s.on : ''}`}>
        <SyncBadge st={sync} mine={mine} />
      </div>
      {/* while the file can't be had (re-select it, or nobody online has it), the buttons stay up, greyed out */}
      <div className={`${s.actions} ${blocked ? s.actionsOn : ''}`}>
        {unlinked && (
          <button className={s.warn} title="Re-select this file: this browser lost access to it" onClick={() => void relink(session, item.key, 'file', item.name)}>
            <Icon name="refresh" size={15} />
          </button>
        )}
        {canSync && (
          <button title={SYNC_TIP} onClick={() => fileSync.syncNow(item)}>
            <Icon name="cloudDown" size={15} />
          </button>
        )}
        <button
          title={blocked ? why : 'Preview'}
          aria-disabled={blocked}
          onClick={() => !blocked && preview(args)}
        >
          <Icon name="eye" size={15} />
        </button>
        <button title={blocked ? why : DOWNLOAD_TIP} aria-disabled={blocked} onClick={() => !blocked && void files.download(args)}>
          <Icon name="download" size={15} />
        </button>
      </div>
    </>
  )
}
