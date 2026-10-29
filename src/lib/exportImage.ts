import { fragmentToHTML, fragmentToText } from '../model/noteSchema'
import { NOTE_FONT_SIZE, type FileItem, type FolderItem, type Item, type LinkItem, type NoteItem, type StrokeItem } from '../model/types'
import type { Session } from '../net/session'
import { embedFor } from './embed'
import { formatSize, kindOf } from './files'
import { unionBounds, type Rect } from './geometry'
import { isImage, isVideo } from './media'
import { strokePath } from './stroke'
import { normalizeUrl } from './url'

/**
 * The whole board as a PNG, drawn onto a canvas from the doc (not a screenshot of the page):
 * strokes from their points, notes as rich text, pictures as sharp as this device holds them,
 * and links as cards (a YouTube video with its thumbnail).
 */

/** Largest canvas side, and area: Safari caps the area at 16.7M pixels. */
const MAX_SIDE = 16384
const MAX_AREA = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) ? 16_777_216 : 100_000_000

const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const INK = '#1f2328'

export interface ExportPlan {
  items: Item[]
  /** the content, before padding */
  area: Rect
}

/** What's on the board (folder contents aren't), or null when it's empty. */
export function planExport(session: Session): ExportPlan | null {
  const items = session.store.getSnapshot().surface.filter((i) => i.type !== 'link' || !!i.url)
  // a stroke's ink runs past its box by half its width
  const boxes = items.map((i) => {
    if (i.type !== 'stroke') return i
    const m = (i.size / 2) * Math.max(i.w / (i.ow || 1), i.h / (i.oh || 1))
    return { ...i, x: i.x - m, y: i.y - m, w: i.w + 2 * m, h: i.h + 2 * m }
  })
  const area = unionBounds(boxes)
  return area ? { items, area } : null
}

/** Pixel size at `scale` px per board unit, and the scale actually used once fitted to the browser's canvas limits. */
export function exportSize(plan: ExportPlan, padding: number, scale: number) {
  const w = plan.area.w + 2 * padding
  const h = plan.area.h + 2 * padding
  const k = Math.min(scale, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h)))
  return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)), scale: k, capped: k < scale }
}

/** "Trip planning 2026-10-29.png" */
export function exportName(board: string) {
  const d = new Date()
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const name = (board.trim() || 'Untitled board').replace(/[\\/:*?"<>|]+/g, ' ').trim()
  return `${name} ${day}.png`
}

function loadImg(src: string, cors = false): Promise<HTMLImageElement | null> {
  return new Promise((done) => {
    const img = new Image()
    if (cors) img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => done(img)
    img.onerror = () => done(null)
    img.src = src
  })
}

const youtubeId = (src?: string) => /youtube-nocookie\.com\/embed\/([\w-]{11})/.exec(src ?? '')?.[1]

/**
 * Pictures for an export, loaded once for the preview and the full render: full size where this
 * device already holds the image, else its thumbnail. Nothing is fetched from peers.
 */
export class ExportAssets {
  private images = new Map<string, Promise<HTMLImageElement | null>>()
  private notes = new Map<string, Promise<HTMLImageElement | null>>()
  private urls: string[] = []

  constructor(private session: Session) {}

  private picture(item: FileItem): Promise<HTMLImageElement | null> {
    let p = this.images.get(item.id)
    if (!p) {
      p = (async () => {
        const blob = isImage(item) ? await this.session.files.localImage(item.owner, item.key, item.hash) : null
        if (blob) {
          const url = URL.createObjectURL(blob)
          this.urls.push(url)
          const img = await loadImg(url)
          if (img) return img
        }
        // the thumbnail is the peer's: only ever an image
        return item.thumb?.startsWith('data:image/') ? loadImg(item.thumb) : null
      })()
      this.images.set(item.id, p)
    }
    return p
  }

  private embedThumb(item: LinkItem): Promise<HTMLImageElement | null> {
    let p = this.images.get(item.id)
    if (!p) {
      const id = youtubeId(embedFor(item.url)?.src)
      // i.ytimg.com allows CORS, so the canvas stays exportable
      p = id ? loadImg(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, true) : Promise.resolve(null)
      this.images.set(item.id, p)
    }
    return p
  }

  /** The note's text as an SVG picture (HTML in a foreignObject), rasterized at `k` px per unit. */
  private note(item: NoteItem, k: number): Promise<HTMLImageElement | null> {
    const fragment = this.session.store.noteFragment(item.id)
    const key = `${item.id}@${k}`
    let p = this.notes.get(key)
    if (!p && fragment) {
      const box = document.createElement('div')
      box.className = 'box'
      box.style.fontSize = `${NOTE_FONT_SIZE}px`
      const style = document.createElement('style')
      style.textContent = NOTE_CSS
      box.appendChild(style)
      if (item.title) {
        const t = document.createElement('div')
        t.className = 'title'
        t.textContent = item.title
        box.appendChild(t)
      }
      const prose = document.createElement('div')
      prose.className = 'prose'
      prose.innerHTML = fragmentToHTML(fragment)
      box.appendChild(prose)
      // serialized as XHTML: an SVG image is XML, so <br> and <input> have to close
      const html = new XMLSerializer().serializeToString(box)
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${item.w * k}" height="${item.h * k}" viewBox="0 0 ${item.w} ${item.h}"><foreignObject x="0" y="0" width="${item.w}" height="${item.h}">${html}</foreignObject></svg>`
      p = loadImg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      this.notes.set(key, p)
    }
    return p ?? Promise.resolve(null)
  }

  /** Everything `items` needs at scale `k`, keyed by item id. */
  async load(items: Item[], k: number, rich: boolean) {
    const out = new Map<string, HTMLImageElement>()
    await Promise.all(
      items.map(async (it) => {
        const img =
          it.type === 'file' ? await this.picture(it) : it.type === 'link' ? await this.embedThumb(it) : it.type === 'note' && rich ? await this.note(it, k) : null
        if (img) out.set(it.id, img)
      }),
    )
    return out
  }

  /** a note's text without formatting, for browsers that won't draw rich notes */
  plain(id: string) {
    const f = this.session.store.noteFragment(id)
    return f ? fragmentToText(f) : ''
  }

  dispose() {
    this.urls.forEach((u) => URL.revokeObjectURL(u))
    this.urls = []
  }
}

/** Note.module.css, for a note drawn outside the page (no CSS modules there) */
const NOTE_CSS = `
.box { width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden; font-family: ${FONT}; color: ${INK}; -webkit-font-smoothing: antialiased; }
.title { flex: none; padding: 10px 14px 0; font-weight: 700; font-size: 1.15em; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title + .prose { padding-top: 6px; }
.prose { flex: 1; min-height: 0; overflow: hidden; padding: 12px 14px; line-height: 1.4; word-break: break-word; }
.prose p { margin: 0 0 0.45em; }
.prose h1, .prose h2, .prose h3, .prose h4, .prose h5, .prose h6 { margin: 0.1em 0 0.35em; line-height: 1.2; }
.prose h1 { font-size: 2em; } .prose h2 { font-size: 1.6em; } .prose h3 { font-size: 1.3em; }
.prose h4 { font-size: 1.12em; } .prose h5 { font-size: 1em; } .prose h6 { font-size: 0.88em; }
.prose ul, .prose ol { margin: 0 0 0.45em; padding-left: 1.3em; }
.prose ul[data-type='taskList'] { list-style: none; padding-left: 0.2em; }
.prose ul[data-type='taskList'] > li { display: flex; gap: 0.5em; align-items: flex-start; }
.prose ul[data-type='taskList'] > li > label { margin-top: 0.15em; }
.prose ul[data-type='taskList'] > li > div { flex: 1; }
.prose ul[data-type='taskList'] > li > div > p { margin: 0; }
.prose ul[data-type='taskList'] > li[data-checked='true'] > div { text-decoration: line-through; opacity: 0.55; }
.prose input { margin: 0; }
.prose code { background: rgba(0, 0, 0, 0.09); padding: 0.1em 0.3em; border-radius: 4px; font-size: 0.9em; }
.prose pre { background: rgba(0, 0, 0, 0.1); padding: 8px 10px; border-radius: 8px; overflow: hidden; white-space: pre-wrap; }
.prose pre code { background: none; padding: 0; }
.prose blockquote { margin: 0 0 0.45em; padding-left: 0.8em; border-left: 3px solid rgba(0, 0, 0, 0.25); }
.prose a { color: #1a56db; text-decoration: underline; }
`

interface Theme {
  bg: string
  panel: string
  border: string
  text: string
  muted: string
  hover: string
}

function theme(): Theme {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d
  return { bg: v('--bg', '#f4f5f7'), panel: v('--panel', '#fff'), border: v('--border', '#dfe3e8'), text: v('--text', INK), muted: v('--muted', '#6a7380'), hover: v('--hover', '#eef1f5') }
}

export interface RenderOpts {
  /** px per board unit (already fitted with exportSize) */
  scale: number
  padding: number
}

/**
 * Draws the plan onto a new canvas. Notes are drawn as rich text where the browser lets an
 * SVG's HTML onto a canvas without locking it; where it doesn't, as plain text.
 */
export async function renderBoard(plan: ExportPlan, assets: ExportAssets, o: RenderOpts): Promise<HTMLCanvasElement> {
  for (const rich of [true, false]) {
    const canvas = await draw(plan, assets, o, rich)
    try {
      canvas.getContext('2d')!.getImageData(0, 0, 1, 1)
      return canvas
    } catch {
      /* tainted by the notes' HTML: once more as plain text */
    }
  }
  throw new Error('This browser won’t export the board as an image')
}

async function draw(plan: ExportPlan, assets: ExportAssets, o: RenderOpts, rich: boolean): Promise<HTMLCanvasElement> {
  const k = o.scale
  const imgs = await assets.load(plan.items, k, rich)
  const t = theme()
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor((plan.area.w + 2 * o.padding) * k))
  canvas.height = Math.max(1, Math.floor((plan.area.h + 2 * o.padding) * k))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The board is too big to draw here')
  ctx.fillStyle = t.bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(k, k)
  ctx.translate(o.padding - plan.area.x, o.padding - plan.area.y)
  ctx.textBaseline = 'alphabetic'
  const d: Draw = { ctx, k, t, img: (id) => imgs.get(id), plain: (id) => assets.plain(id) }
  for (const it of plan.items) {
    ctx.save()
    // rotated about its centre, like the CSS transform on the board
    ctx.translate(it.x + it.w / 2, it.y + it.h / 2)
    ctx.rotate(it.rot)
    ctx.translate(-it.w / 2, -it.h / 2)
    if (it.type === 'stroke') drawStroke(d, it)
    else if (it.type === 'note') drawNote(d, it, rich)
    else if (it.type === 'file') drawFile(d, it)
    else if (it.type === 'folder') drawFolder(d, it)
    else drawLink(d, it)
    ctx.restore()
  }
  return canvas
}

interface Draw {
  ctx: CanvasRenderingContext2D
  /** px per unit: shadows don't follow the transform, so they're scaled by hand */
  k: number
  t: Theme
  img(id: string): HTMLImageElement | undefined
  plain(id: string): string
}

function shadow(d: Draw, color: string, blur: number, y: number) {
  d.ctx.shadowColor = color
  d.ctx.shadowBlur = blur * d.k
  d.ctx.shadowOffsetY = y * d.k
}

function noShadow(d: Draw) {
  d.ctx.shadowColor = 'transparent'
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | number[]) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/** `img` scaled to cover the box, like object-fit: cover (clip to the box first) */
function cover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const iw = img.naturalWidth * s
  const ih = img.naturalHeight * s
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih)
}

/** `text` cut to `max` wide with an ellipsis */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}

function text(d: Draw, s: string, x: number, y: number, max: number, font: string, color: string) {
  d.ctx.font = `${font} ${FONT}`
  d.ctx.fillStyle = color
  d.ctx.fillText(fit(d.ctx, s, max), x, y)
}

function playButton(d: Draw, cx: number, cy: number, r: number) {
  const { ctx } = d
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  const a = r * 0.42
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.moveTo(cx - a * 0.7, cy - a)
  ctx.lineTo(cx + a, cy)
  ctx.lineTo(cx - a * 0.7, cy + a)
  ctx.fill()
}

function drawStroke(d: Draw, it: StrokeItem) {
  const { ctx } = d
  const hl = it.opacity < 1
  const path = strokePath(it.points, it.size, hl)
  if (!path) return
  ctx.scale(it.w / (it.ow || 1), it.h / (it.oh || 1))
  ctx.globalAlpha = it.opacity
  if (hl) ctx.globalCompositeOperation = 'multiply'
  ctx.fillStyle = it.color
  ctx.fill(new Path2D(path))
}

function drawNote(d: Draw, it: NoteItem, rich: boolean) {
  const { ctx } = d
  shadow(d, 'rgba(0, 0, 0, 0.16)', 16, 6)
  rounded(ctx, 0, 0, it.w, it.h, 12)
  ctx.fillStyle = it.color
  ctx.fill()
  noShadow(d)
  ctx.clip()
  const img = d.img(it.id)
  if (rich && img) return void ctx.drawImage(img, 0, 0, it.w, it.h)
  // plain text: the title, then the text wrapped to the note's width
  const size = NOTE_FONT_SIZE
  let y = 10
  if (it.title) {
    y += size * 1.15 * 1.1
    text(d, it.title, 14, y, it.w - 28, `700 ${size * 1.15}px`, INK)
    y += 6
  } else y += 2
  ctx.font = `${size}px ${FONT}`
  ctx.fillStyle = INK
  const line = size * 1.4
  for (const l of wrap(ctx, d.plain(it.id), it.w - 28)) {
    y += line
    if (y > it.h - 6) break
    ctx.fillText(l, 14, y - line * 0.25)
  }
}

function wrap(ctx: CanvasRenderingContext2D, s: string, max: number): string[] {
  const out: string[] = []
  for (const para of s.split('\n')) {
    let cur = ''
    for (const word of para.split(/(\s+)/)) {
      const next = cur + word
      if (cur && ctx.measureText(next).width > max) {
        out.push(cur.trimEnd())
        cur = word.trimStart()
      } else cur = next
    }
    out.push(cur)
  }
  return out
}

function drawFile(d: Draw, it: FileItem) {
  const { ctx, t } = d
  const img = d.img(it.id)
  if (isImage(it) || isVideo(it)) {
    // bare, like on the board
    shadow(d, 'rgba(16, 24, 40, 0.14)', 12, 4)
    rounded(ctx, 0, 0, it.w, it.h, 2)
    ctx.fillStyle = img ? '#000' : t.hover
    ctx.fill()
    noShadow(d)
    ctx.save()
    ctx.clip()
    if (img) cover(ctx, img, 0, 0, it.w, it.h)
    ctx.restore()
    if (isVideo(it)) playButton(d, it.w / 2, it.h / 2, 26)
    return
  }
  card(d, it.w, it.h)
  ctx.save()
  rounded(ctx, 0, 0, it.w, it.h, 12)
  ctx.clip()
  const info = 50
  const th = it.h - info
  ctx.fillStyle = t.hover
  ctx.fillRect(0, 0, it.w, th)
  const kind = kindOf(it.name, it.mime)
  if (img) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, it.w, th)
    ctx.clip()
    cover(ctx, img, 0, 0, it.w, th)
    ctx.restore()
    if (kind === 'video') playButton(d, it.w / 2, th / 2, 17)
  } else {
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(it.name)?.[1] ?? kind).toUpperCase()
    ctx.textAlign = 'center'
    text(d, ext, it.w / 2, th / 2 + 7, it.w - 20, '700 20px', t.muted)
    ctx.textAlign = 'start'
  }
  ctx.restore()
  text(d, it.name, 10, th + 22, it.w - 20, '600 13px', t.text)
  text(d, `${formatSize(it.size)} · ${it.ownerName}`, 10, th + 40, it.w - 20, '12px', t.muted)
}

/** a panel card: rounded, bordered, and shadowed */
function card(d: Draw, w: number, h: number, fill = d.t.panel) {
  const { ctx } = d
  shadow(d, 'rgba(16, 24, 40, 0.12)', 14, 4)
  rounded(ctx, 0, 0, w, h, 12)
  ctx.fillStyle = fill
  ctx.fill()
  noShadow(d)
  ctx.strokeStyle = d.t.border
  ctx.lineWidth = 1
  rounded(ctx, 0.5, 0.5, w - 1, h - 1, 11.5)
  ctx.stroke()
}

const FOLDER_BACK = new Path2D('M6 14a8 8 0 018-8h26l10 10h56a8 8 0 018 8v54a8 8 0 01-8 8H14a8 8 0 01-8-8z')
const FOLDER_FRONT = new Path2D('M6 30h108v48a8 8 0 01-8 8H14a8 8 0 01-8-8z')

function drawFolder(d: Draw, it: FolderItem) {
  const { ctx } = d
  ctx.save()
  ctx.scale(it.w / 120, it.h / 92)
  shadow(d, 'rgba(16, 24, 40, 0.18)', 8, 4)
  ctx.fillStyle = it.color
  ctx.fill(FOLDER_BACK)
  noShadow(d)
  ctx.globalAlpha = 0.22
  ctx.fillStyle = '#fff'
  ctx.fill(FOLDER_FRONT)
  ctx.restore()
  text(d, it.name, 22, it.h - 24, it.w - 40, '600 13px', '#1c2026')
}

function drawLink(d: Draw, it: LinkItem) {
  const { ctx, t } = d
  const url = normalizeUrl(it.url)
  const host = url ? new URL(url).host : ''
  const embed = it.card ? null : embedFor(it.url)
  if (embed && url) {
    card(d, it.w, it.h, '#000')
    ctx.save()
    rounded(ctx, 0, 0, it.w, it.h, 12)
    ctx.clip()
    ctx.fillStyle = t.panel
    ctx.fillRect(0, 0, it.w, 32)
    ctx.fillStyle = t.border
    ctx.fillRect(0, 31, it.w, 1)
    const img = d.img(it.id)
    ctx.beginPath()
    ctx.rect(0, 32, it.w, it.h - 32)
    ctx.clip()
    // a YouTube thumbnail is 4:3 with black bars: covering the 16:9 player crops them off
    if (img) cover(ctx, img, 0, 32, it.w, it.h - 32)
    else {
      ctx.textAlign = 'center'
      text(d, embed.provider, it.w / 2, 32 + (it.h - 32) / 2 + 6, it.w - 20, '600 16px', 'rgba(255, 255, 255, 0.7)')
      ctx.textAlign = 'start'
    }
    if (img && youtubeId(embed.src)) playButton(d, it.w / 2, 32 + (it.h - 32) / 2, 24)
    ctx.restore()
    text(d, it.title || embed.provider, 10, 21, it.w - 20, '600 13px', t.text)
    return
  }
  card(d, it.w, it.h)
  const cy = it.h / 2
  rounded(ctx, 14, cy - 18, 36, 36, 10)
  ctx.fillStyle = t.hover
  ctx.fill()
  ctx.textAlign = 'center'
  text(d, (host.replace(/^www\./, '')[0] ?? '?').toUpperCase(), 32, cy + 6, 30, '700 16px', t.muted)
  ctx.textAlign = 'start'
  const x = 62
  text(d, it.title || host || 'Invalid link', x, cy - 3, it.w - x - 14, '600 13px', t.text)
  text(d, url ? url.replace(/^https?:\/\//, '') : 'Blocked: not an http(s) link', x, cy + 15, it.w - x - 14, '12px', t.muted)
}

export function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('The board is too big to save as an image here'))), 'image/png'))
}

export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
