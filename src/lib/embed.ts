import { DEFAULT_SIZE } from '../model/types'
import { normalizeUrl } from './url'

/**
 * A player/viewer for a link from a known provider. `src` is rebuilt from ids parsed out of the
 * URL on a fixed provider host, so a peer can't get an arbitrary page framed on everyone's board.
 */
export interface Embed {
  provider: string
  src?: string
  /** for providers that only offer a script embed (gists): rendered in a scripts-only sandbox */
  srcdoc?: string
  w: number
  h: number
}

const ID = /^[\w-]+$/

const ytStart = (t: string | null) => {
  if (!t) return 0
  if (/^\d+$/.test(t)) return +t
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t)
  return m ? +(m[1] ?? 0) * 3600 + +(m[2] ?? 0) * 60 + +(m[3] ?? 0) : 0
}

function youtube(u: URL, host: string): Embed | null {
  let id: string | null = null
  let shorts = false
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0]
  else if (/(^|\.)youtube\.com$/.test(host)) {
    const m = /^\/(shorts|live|embed)\/([\w-]+)/.exec(u.pathname)
    if (m) {
      id = m[2]
      shorts = m[1] === 'shorts'
    } else if (u.pathname === '/watch') id = u.searchParams.get('v')
    else if (u.pathname === '/playlist') {
      const list = u.searchParams.get('list')
      if (list && ID.test(list)) return { provider: 'YouTube', src: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`, w: 480, h: 270 }
    }
  } else return null
  if (!id || !/^[\w-]{11}$/.test(id)) return null
  const start = ytStart(u.searchParams.get('t') ?? u.searchParams.get('start'))
  const src = `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`
  return shorts ? { provider: 'YouTube', src, w: 270, h: 480 } : { provider: 'YouTube', src, w: 480, h: 270 }
}

function vimeo(u: URL): Embed | null {
  const m = /^\/(\d+)(?:\/([\da-f]+))?\/?$/.exec(u.pathname)
  if (!m) return null
  return { provider: 'Vimeo', src: `https://player.vimeo.com/video/${m[1]}${m[2] ? `?h=${m[2]}` : ''}`, w: 480, h: 270 }
}

function spotify(u: URL): Embed | null {
  const m = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/.exec(u.pathname)
  if (!m) return null
  const short = m[1] === 'track' || m[1] === 'episode'
  return { provider: 'Spotify', src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, w: 380, h: short ? 152 : 352 }
}

function soundcloud(u: URL): Embed | null {
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length < 2 || !parts.every((p) => ID.test(p))) return null
  const track = `https://soundcloud.com/${parts.join('/')}`
  return { provider: 'SoundCloud', src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(track)}`, w: 420, h: parts[1] === 'sets' ? 380 : 166 }
}

function googleMaps(u: URL): Embed | null {
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?/.exec(u.pathname)
  const place = /\/place\/([^/]+)/.exec(u.pathname)
  const q = u.searchParams.get('q') ?? u.searchParams.get('query') ?? (place ? decodeURIComponent(place[1].replace(/\+/g, ' ')) : at ? `${at[1]},${at[2]}` : null)
  if (!q) return null
  const z = at?.[3] ? Math.round(+at[3]) : null
  return { provider: 'Google Maps', src: `https://maps.google.com/maps?q=${encodeURIComponent(q)}${z ? `&z=${z}` : ''}&output=embed`, w: 480, h: 360 }
}

function osm(u: URL): Embed | null {
  const m = /map=(\d+)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(u.hash)
  const mlat = u.searchParams.get('mlat')
  const mlon = u.searchParams.get('mlon')
  const z = m ? +m[1] : 15
  const lat = m ? +m[2] : mlat ? +mlat : NaN
  const lon = m ? +m[3] : mlon ? +mlon : NaN
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  // a 480 x 360 view at zoom z covers about 480/256 tiles of 360/2^z degrees each
  const dLon = ((360 / 2 ** z) * 480) / 256 / 2
  const dLat = (dLon * 360) / 480
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((n) => n.toFixed(5)).join(',')
  const marker = mlat && mlon ? `&marker=${+mlat},${+mlon}` : ''
  return { provider: 'OpenStreetMap', src: `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik${marker}`, w: 480, h: 360 }
}

function google(u: URL, host: string): Embed | null {
  const p = u.pathname
  if (host === 'drive.google.com') {
    const m = /^\/file\/d\/([\w-]+)/.exec(p)
    return m ? { provider: 'Google Drive', src: `https://drive.google.com/file/d/${m[1]}/preview`, w: 480, h: 360 } : null
  }
  const m = /^\/(document|spreadsheets|presentation)\/d\/(e\/)?([\w-]+)/.exec(p)
  if (!m) return null
  const [, kind, published, id] = m
  const base = `https://docs.google.com/${kind}/d/${published ?? ''}${id}`
  if (kind === 'document') return { provider: 'Google Docs', src: published ? `${base}/pub?embedded=true` : `${base}/preview`, w: 480, h: 620 }
  if (kind === 'spreadsheets') return { provider: 'Google Sheets', src: published ? `${base}/pubhtml?widget=true` : `${base}/preview`, w: 560, h: 380 }
  return { provider: 'Google Slides', src: `${base}/${published ? 'embed' : 'preview'}`, w: 480, h: 300 }
}

function figma(u: URL): Embed | null {
  if (!/^\/(file|design|proto|board|slides|deck)\/[\w-]+/.test(u.pathname)) return null
  return { provider: 'Figma', src: `https://www.figma.com/embed?embed_host=gooseboard&url=${encodeURIComponent(u.href)}`, w: 480, h: 320 }
}

function miro(u: URL): Embed | null {
  const m = /^\/app\/board\/([\w=-]+)/.exec(u.pathname)
  return m ? { provider: 'Miro', src: `https://miro.com/app/live-embed/${m[1]}/`, w: 560, h: 380 } : null
}

function codepen(u: URL): Embed | null {
  const m = /^\/([\w-]+)\/(?:pen|full|details|embed)\/([\w-]+)/.exec(u.pathname)
  return m ? { provider: 'CodePen', src: `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`, w: 520, h: 380 } : null
}

function gist(u: URL): Embed | null {
  const m = /^\/([\w-]+)\/([\da-f]+)\/?$/.exec(u.pathname)
  if (!m) return null
  const srcdoc = `<!doctype html><base target="_blank"><style>body{margin:0}.gist .blob-wrapper{max-height:none}</style><script src="https://gist.github.com/${m[1]}/${m[2]}.js"></script>`
  return { provider: 'GitHub Gist', srcdoc, w: 480, h: 360 }
}

export function embedFor(url: string): Embed | null {
  const n = normalizeUrl(url)
  if (!n) return null
  const u = new URL(n)
  const host = u.hostname.replace(/^(www|m)\./, '')
  switch (host) {
    case 'youtu.be':
    case 'youtube.com':
    case 'music.youtube.com':
    case 'youtube-nocookie.com':
      return youtube(u, host)
    case 'vimeo.com':
      return vimeo(u)
    case 'open.spotify.com':
      return spotify(u)
    case 'soundcloud.com':
      return soundcloud(u)
    case 'google.com':
    case 'maps.google.com':
      return u.pathname.startsWith('/maps') || host === 'maps.google.com' ? googleMaps(u) : null
    case 'openstreetmap.org':
      return osm(u)
    case 'docs.google.com':
    case 'drive.google.com':
      return google(u, host)
    case 'figma.com':
      return figma(u)
    case 'miro.com':
      return miro(u)
    case 'codepen.io':
      return codepen(u)
    case 'gist.github.com':
      return gist(u)
  }
  return null
}

/** Box for a link item showing `url`, as an embed unless `card`, keeping the old box's centre. */
export function linkBox(old: { x: number; y: number; w: number; h: number }, url: string, card?: boolean) {
  const e = card ? null : embedFor(url)
  const { w, h } = e ?? DEFAULT_SIZE.link
  return { x: Math.round(old.x + old.w / 2 - w / 2), y: Math.round(old.y + old.h / 2 - h / 2), w, h }
}
