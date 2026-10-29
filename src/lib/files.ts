export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'doc' | 'sheet' | 'slides' | 'code' | 'text' | 'other'

export const extOf = (name: string) => {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : ''
}

const EXT_KIND: Record<string, FileKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image', bmp: 'image', ico: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio',
  pdf: 'pdf',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive',
  doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', pages: 'doc',
  xls: 'sheet', xlsx: 'sheet', csv: 'sheet', ods: 'sheet', numbers: 'sheet', tsv: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides',
  js: 'code', ts: 'code', tsx: 'code', jsx: 'code', py: 'code', rs: 'code', go: 'code', java: 'code', c: 'code', cpp: 'code', h: 'code',
  json: 'code', html: 'code', css: 'code', sh: 'code', rb: 'code', php: 'code', yml: 'code', yaml: 'code', toml: 'code', sql: 'code',
  txt: 'text', md: 'text', log: 'text',
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  avif: 'image/avif', bmp: 'image/bmp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html',
}

export const mimeOf = (name: string, mime?: string) => mime || EXT_MIME[extOf(name)] || 'application/octet-stream'

export function kindOf(name: string, mime?: string): FileKind {
  if (mime?.startsWith('image/')) return 'image'
  if (mime?.startsWith('video/')) return 'video'
  if (mime?.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  return EXT_KIND[extOf(name)] ?? 'other'
}

export function formatSize(n: number): string {
  if (!Number.isFinite(n)) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`
}

export const KIND_COLOR: Record<FileKind, string> = {
  image: '#30a46c', video: '#8e4ec6', audio: '#d6409f', pdf: '#e5484d', archive: '#d9a400', doc: '#3e63dd',
  sheet: '#2b9a66', slides: '#f76b15', code: '#0fa5a5', text: '#6e7781', other: '#6e7781',
}

export const canSavePicker = () => typeof (window as any).showSaveFilePicker === 'function'
export const canDirPicker = () => typeof (window as any).showDirectoryPicker === 'function'
export const canOpenPicker = () => typeof (window as any).showOpenFilePicker === 'function'

export const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim())

/** What a file's Download button does, for its tooltip. */
export const DOWNLOAD_TIP = 'Download: save the file to this device, to keep or to open in another app'
/** What a file's Sync button does, for its tooltip. */
export const SYNC_TIP = 'Sync: keep a copy in this browser, so it opens instantly, stays available when its owner is offline, and others can get it from you'
