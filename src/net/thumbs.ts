const MAX_DIM = 256

function canvasToBlob(c: HTMLCanvasElement, q: number): Promise<Blob | null> {
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', q))
}

function drawScaled(src: CanvasImageSource, w: number, h: number, maxDim: number): HTMLCanvasElement {
  const s = Math.min(1, maxDim / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * s))
  c.height = Math.max(1, Math.round(h * s))
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
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

async function imageThumb(file: File, maxDim: number): Promise<Blob | null> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await withTimeout(img.decode(), 10000)
    return await canvasToBlob(drawScaled(img, img.naturalWidth || 256, img.naturalHeight || 256, maxDim), 0.72)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function videoThumb(file: File, maxDim: number): Promise<Blob | null> {
  const url = URL.createObjectURL(file)
  try {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.playsInline = true
    v.src = url
    await withTimeout(
      new Promise<void>((res, rej) => {
        v.onloadeddata = () => {
          v.onseeked = () => res()
          v.currentTime = Math.min(1, (v.duration || 2) * 0.1)
        }
        v.onerror = () => rej(new Error('video'))
      }),
      10000,
    )
    return await canvasToBlob(drawScaled(v, v.videoWidth || 320, v.videoHeight || 180, maxDim), 0.72)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Small JPEG preview for images and videos; null for everything else (UI shows a type icon). */
export async function makeThumb(file: File, maxDim = MAX_DIM): Promise<Blob | null> {
  try {
    if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(file.name)) return await imageThumb(file, maxDim)
    if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name)) return await videoThumb(file, maxDim)
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
