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
