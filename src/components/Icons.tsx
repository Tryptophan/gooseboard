import type { ReactNode } from 'react'

const P: Record<string, ReactNode> = {
  select: <path d="M5 3l14 8-6 2-3 6z" />,
  hand: <path d="M8 13V5.5a1.5 1.5 0 013 0V11m0-6.5a1.5 1.5 0 013 0V11m0-4.5a1.5 1.5 0 013 0V13m0-3.5a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-1.5a6 6 0 01-4.7-2.3L4 14.5a1.6 1.6 0 012.4-2L8 14" />,
  pen: <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19zM14.5 6.5l3 3" />,
  highlighter: <path d="M9 14l6-6 3 3-6 6H9zM9 17l-3 3h5M15 8l2-2 3 3-2 2" />,
  eraser: <path d="M8 20h12M5.5 14.5l8-8a2 2 0 013 0l2 2a2 2 0 010 3l-7 7H8.5a2 2 0 01-1.4-.6l-1.6-1.6a2 2 0 010-2.8z" />,
  note: <path d="M5 4h14v10l-6 6H5zM13 20v-6h6" />,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  link: <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />,
  file: <path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" />,
  disk: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2zM12 10v6M9 13l3 3 3-3" />,
  undo: <path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" />,
  redo: <path d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  share: <path d="M12 3v12M8 7l4-4 4 4M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" />,
  sun: <path d="M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" />,
  moon: <path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  copy: <path d="M9 9h10v11H9zM5 15V4h10" />,
  front: <path d="M9 9h11v11H9zM4 4h11v5M4 4v11h5" />,
  back: <path d="M4 4h11v11H4zM9 20h11V9h-5" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />,
  eye: <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  home: <path d="M4 11l8-7 8 7M6 10v10h12V10" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  refresh: <path d="M20 11a8 8 0 00-14-4L4 9M4 4v5h5M4 13a8 8 0 0014 4l2-2M20 20v-5h-5" />,
  user: <path d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0" />,
  bold: <path d="M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z" />,
  italic: <path d="M10 5h8M6 19h8M14 5l-4 14" />,
  strike: <path d="M5 12h14M16 7a4 4 0 00-4-2c-2.5 0-4 1.2-4 3s1.5 2.5 4 3 4 1.2 4 3-1.5 3-4 3a4.5 4.5 0 01-4.5-2" />,
  ul: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  ol: <path d="M10 6h10M10 12h10M10 18h10M4 5l1-1v4M4 14h2l-2 3h2" />,
  check: <path d="M4 6l2 2 3-3M4 14l2 2 3-3M12 7h8M12 15h8" />,
  heading: <path d="M6 4v16M18 4v16M6 12h12" />,
  code: <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />,
  follow: <path d="M12 5a7 7 0 100 14 7 7 0 000-14zM12 9a3 3 0 100 6 3 3 0 000-6z" />,
  lock: <path d="M6 11h12v9H6zM8 11V8a4 4 0 018 0v3" />,
}

export function Icon({ name, size = 20 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {P[name]}
    </svg>
  )
}
