import { extOf, KIND_COLOR, kindOf } from '../lib/files'

/** Generic file glyph coloured by category, labelled with the extension. */
export function TypeIcon({ name, mime, size = 56 }: { name: string; mime?: string; size?: number }) {
  const color = KIND_COLOR[kindOf(name, mime)]
  const ext = (extOf(name) || 'file').slice(0, 4).toUpperCase()
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 48 56" aria-hidden>
      <path d="M6 4a3 3 0 013-3h20l13 13v38a3 3 0 01-3 3H9a3 3 0 01-3-3z" fill={color} opacity="0.16" />
      <path d="M6 4a3 3 0 013-3h20l13 13v38a3 3 0 01-3 3H9a3 3 0 01-3-3z" fill="none" stroke={color} strokeWidth="2" />
      <path d="M29 1v10a3 3 0 003 3h10" fill="none" stroke={color} strokeWidth="2" />
      <text x="24" y="40" textAnchor="middle" fontSize={ext.length > 3 ? 10 : 12} fontWeight="700" fill={color} fontFamily="system-ui, sans-serif">
        {ext}
      </text>
    </svg>
  )
}

/** In place of a video's missing thumbnail (rather than a blank box): a dark frame, a play mark, and the format. */
export function VideoPoster({ name, play = true }: { name: string; play?: boolean }) {
  const ext = (extOf(name) || 'video').slice(0, 4).toUpperCase()
  return (
    <div
      aria-hidden
      style={{ position: 'relative', width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, #2c3350, #12151f)', color: '#fff' }}
    >
      {play && (
        <svg width="34" height="34" viewBox="0 0 34 34">
          <circle cx="17" cy="17" r="16" fill="rgba(255,255,255,0.16)" />
          <path d="M13.5 10.5v13l10.5-6.5z" fill="#fff" />
        </svg>
      )}
      <span style={{ position: 'absolute', left: 8, bottom: 6, font: '700 10px system-ui, sans-serif', letterSpacing: '0.06em', opacity: 0.7 }}>{ext}</span>
    </div>
  )
}
