const MAX_DIM = 256
/** Board-sized rendition of an image: sharp on screen without moving the original around. */
export const PREVIEW_DIM = 1600

function canvasToBlob(c: HTMLCanvasElement, q: number, type = 'image/jpeg'): Promise<Blob | null> {
  return new Promise((res) => c.toBlob((b) => res(b), type, q))
}

function drawScaled(src: CanvasImageSource, w: number, h: number, maxDim: number, fill = true): HTMLCanvasElement {
  const s = Math.min(1, maxDim / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * s))
  c.height = Math.max(1, Math.round(h * s))
  const ctx = c.getContext('2d')!
  if (fill) {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, c.width, c.height)
  return c
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    )
  })
}

async function decodeImage<T>(file: Blob, draw: (img: HTMLImageElement, w: number, h: number) => Promise<T>): Promise<T> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await withTimeout(img.decode(), 10000)
    return await draw(img, img.naturalWidth || 256, img.naturalHeight || 256)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** below this, decoding in full costs little, and a small picture isn't blown up first */
const SMALL_IMAGE = 1024 * 1024

/**
 * A big image decoded straight to about `maxDim` wide (the browser can shrink as it decodes, rather
 * than unpacking all 24 megapixels of a photo first), then fitted inside `maxDim`; null where that
 * isn't possible (SVG, Safari's older createImageBitmap), to decode it the usual way.
 */
async function decodeSmall(file: Blob, maxDim: number): Promise<HTMLCanvasElement | null> {
  if (file.size < SMALL_IMAGE || typeof createImageBitmap !== 'function') return null
  let bmp: ImageBitmap
  try {
    bmp = await withTimeout(createImageBitmap(file, { resizeWidth: maxDim, resizeQuality: 'high' }), 10000)
  } catch {
    return null
  }
  try {
    return drawScaled(bmp, bmp.width, bmp.height, maxDim)
  } finally {
    bmp.close()
  }
}

async function imageThumb(file: Blob, maxDim: number) {
  const small = await decodeSmall(file, maxDim)
  if (small) return canvasToBlob(small, 0.72)
  return decodeImage(file, (img, w, h) => canvasToBlob(drawScaled(img, w, h, maxDim), 0.72))
}

const isImageFile = (file: { type: string; name?: string }) => file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(file.name ?? '')
/** formats that can be see-through: their previews keep the alpha channel */
const mayHaveAlpha = (file: { type: string; name?: string }) => /png|gif|webp|svg|avif/i.test(file.type || file.name || '')

const isVideoFile = (file: { type: string; name?: string }) => file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|3gp|mkv)$/i.test(file.name ?? '')

/** Natural pixel size of an image or video file, or null if it isn't one or won't decode. */
export async function mediaSize(file: File): Promise<{ w: number; h: number } | null> {
  try {
    if (isImageFile(file)) return await decodeImage(file, async (_img, w, h) => ({ w, h }))
    if (isVideoFile(file)) return await videoSize(file)
  } catch {
    /* unsupported codec / broken file: shown as a card */
  }
  return null
}

/**
 * Runs `run` on `file` loaded into a <video>. Phone browsers (iOS Safari above all) often never load
 * a video that isn't in the page, so it sits off-screen in the page until `run` is done.
 */
async function withVideo<T>(file: File, run: (v: HTMLVideoElement) => Promise<T>, ms = 20000): Promise<T> {
  const url = URL.createObjectURL(file)
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.setAttribute('playsinline', '')
  v.preload = 'auto'
  v.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0;pointer-events:none'
  document.body.appendChild(v)
  try {
    v.src = url
    v.load()
    await withTimeout(
      new Promise<void>((res, rej) => {
        if (v.readyState >= 1) return res()
        v.onloadedmetadata = () => res()
        v.onerror = () => rej(new Error('video'))
      }),
      ms,
    )
    return await withTimeout(run(v), ms)
  } finally {
    v.removeAttribute('src')
    v.load()
    v.remove()
    URL.revokeObjectURL(url)
  }
}

const videoSize = (file: File) => withVideo(file, async (v) => (v.videoWidth && v.videoHeight ? { w: v.videoWidth, h: v.videoHeight } : null))

/**
 * Resolves once a frame at the current time can be drawn: when one is presented, or after a moment
 * (a video kept off-screen may never present one, though it has decoded it).
 */
function frameReady(v: HTMLVideoElement): Promise<void> {
  const rvfc = (v as any).requestVideoFrameCallback?.bind(v)
  return new Promise((res) => {
    setTimeout(res, 800)
    if (rvfc) rvfc(() => res())
    else if (v.readyState >= 2) res()
    else v.onloadeddata = () => res()
  })
}

/** Pixel size of a data: URL thumbnail, for media added before sizes were recorded. */
export async function thumbSize(thumb: string): Promise<{ w: number; h: number } | null> {
  const img = new Image()
  img.src = thumb
  return img.decode().then(
    () => (img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null),
    () => null,
  )
}

/** The PREVIEW_DIM rendition shown on the board. */
export async function makePreview(file: Blob, name = ''): Promise<Blob | null> {
  const f = { type: file.type, name }
  try {
    // see-through pictures keep the usual path, whose canvas isn't filled white
    if (!mayHaveAlpha(f)) {
      const small = await decodeSmall(file, PREVIEW_DIM)
      if (small) return await canvasToBlob(small, 0.85)
    }
    return await decodeImage(file, async (img, w, h) => {
      const alpha = mayHaveAlpha(f)
      // Safari can't encode WebP and hands back a PNG, which is fine
      return canvasToBlob(drawScaled(img, w, h, PREVIEW_DIM, !alpha), 0.85, alpha ? 'image/webp' : 'image/jpeg')
    })
  } catch {
    return null
  }
}

/** past this, loading a video for one frame is slow and heavy: it shows the video placeholder instead */
const HUGE_VIDEO = 2 * 1024 ** 3

async function videoThumb(file: File, maxDim: number): Promise<Blob | null> {
  if (file.size > HUGE_VIDEO) return null
  return withVideo(file, async (v) => {
    await new Promise<void>((res) => {
      v.onseeked = () => res()
      v.currentTime = Math.min(1, (v.duration || 2) * 0.1)
    })
    await frameReady(v)
    const c = drawScaled(v, v.videoWidth || 320, v.videoHeight || 180, maxDim, false)
    // no frame was ever drawn (an unsupported codec, or one never presented off-screen): not a white box
    if (blank(c)) return null
    return canvasToBlob(c, 0.72)
  })
}

/** True when a canvas is one flat colour, or nothing at all, sampled on a grid. */
function blank(c: HTMLCanvasElement): boolean {
  const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
  const step = Math.max(4, Math.floor(data.length / 4 / 400)) * 4
  for (let i = step; i < data.length; i += step) {
    if (data[i + 3] && Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]) > 24) return false
  }
  return true
}

/** Small JPEG preview for images and videos; null for everything else (UI shows a type icon). */
export async function makeThumb(file: File, maxDim = MAX_DIM): Promise<Blob | null> {
  try {
    if (isImageFile(file)) return await imageThumb(file, maxDim)
    if (isVideoFile(file)) return await videoThumb(file, maxDim)
  } catch {
    /* unsupported codec / broken file: fall back to icon */
  }
  return null
}

export function blobToDataURL(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(b)
  })
}
