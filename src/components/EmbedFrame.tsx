import type { CSSProperties } from 'react'
import type { Embed } from '../lib/embed'

/** The provider's player, sandboxed; shared by the board card and the preview window. */
export function EmbedFrame({ embed, title, className, style }: { embed: Embed; title: string; className?: string; style?: CSSProperties }) {
  return (
    <iframe
      className={className}
      style={style}
      title={title}
      src={embed.src}
      srcDoc={embed.srcdoc}
      sandbox={embed.srcdoc ? 'allow-scripts allow-popups' : 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation allow-forms'}
      allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
      loading="lazy"
    />
  )
}
