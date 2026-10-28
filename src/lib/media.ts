import { kindOf } from './files'
import type { FileItem, Item } from '../model/types'

/** Longest side of a picture or video when it first lands on the board. */
export const MEDIA_SIDE = 320

export type MediaItem = FileItem & { iw: number; ih: number }

const kindIs = (it: Item | undefined, k: 'image' | 'video'): it is MediaItem => it?.type === 'file' && !!it.iw && !!it.ih && kindOf(it.name, it.mime) === k

/** An image file shown as a bare picture (not a file card). */
export const isImage = (it: Item | undefined) => kindIs(it, 'image')
/** A video file shown as a bare, playable video. */
export const isVideo = (it: Item | undefined) => kindIs(it, 'video')
export const isMedia = (it: Item | undefined) => isImage(it) || isVideo(it)

/** Board size for media of natural size iw x ih. */
export function mediaBox(iw: number, ih: number, side = MEDIA_SIDE) {
  const k = side / Math.max(iw, ih)
  return { w: Math.max(40, Math.round(iw * k)), h: Math.max(40, Math.round(ih * k)) }
}

const VOLUME_KEY = 'gooseboard:volume'

/** One volume (and mute) for every video and audio player, remembered in this browser. */
export function loadVolume(el: HTMLMediaElement) {
  try {
    const v = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? 'null') as { volume: number; muted: boolean } | null
    if (!v) return
    el.volume = Math.min(1, Math.max(0, v.volume))
    el.muted = v.muted
  } catch {
    /* nothing saved, or private mode */
  }
}

export function saveVolume(el: HTMLMediaElement) {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: el.volume, muted: el.muted }))
  } catch {
    /* private mode: lasts this page */
  }
}
