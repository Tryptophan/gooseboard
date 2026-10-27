# Gooseboard

A simple collaborative decentralized workspace for notes, ink, files and folders, shared live between browsers. No accounts, no cloud: open [gooseboard.io](https://gooseboard.io), share the link, and everyone with it edits the same board in real time, peer to peer.

## Features

**On the board**
- **Notes** with rich text and markdown shortcuts (`#` headings, `**bold**`, `-` lists, `[ ]` checklists, code blocks). Edit in place, or open a note in its own window for longer writing.
- **Freehand ink** with pressure from a stylus, plus an eraser.
- **Files** of any kind: drop, paste or pick them. Images and videos get thumbnails. Images, video, audio, PDFs and text open in a built-in viewer, and big media streams while it loads.
- **Folders** to group items, with breadcrumbs and drag-in / drag-out. **Disk folders** share a folder from your computer, browsed live by everyone.
- **Links** as cards or live embeds (YouTube, Vimeo, Spotify, SoundCloud, Google Maps, OpenStreetMap, Google Docs and Drive), switchable per link.
- Select, move, resize, rotate, duplicate, reorder, copy/cut/paste between boards, and undo/redo everything.

**Together**
- Live cursors and names for everyone on the board. Click someone's avatar to follow their view.
- Pick your own name and colour. They're stored in your browser, with no sign-up.
- Edits merge cleanly even when people change the same note at once, and offline edits sync when you reconnect.

**Files without uploads**
- Files stay on the owner's computer and stream straight to whoever opens them.
- Small files (≤ 2 MB) are copied to everyone automatically. Bigger ones are fetched on demand, and anyone who has a copy can serve it, so a file stays available when its owner goes offline.
- Every card shows whether a file is synced and how many people online have it. Downloads are hash-verified.

**Anywhere**
- Works on desktop, tablets and phones. On touch: drag to pan, pinch to zoom, double-tap to add a note, tap a selected note to edit it, and hold for the menu (hold and drag to select several items).
- With a stylus, the pen draws while your fingers pan and zoom.
- Light and dark themes, a minimap, and keyboard shortcuts throughout.

## How it works
- **Peer to peer.** Board data is a [Yjs](https://yjs.dev) document synced over WebRTC between everyone on the board (full mesh) and saved in each browser's IndexedDB. Your board list and profile live in `localStorage`.
- **No server.** Peers find each other through public Nostr relays and WebTorrent trackers, used at the same time, so any one of them being down is fine. Every handshake is encrypted with the board id, so relays see only ciphertext and people without the link can't join. There is no TURN relay, so very strict NATs may fail to connect.
- **Private links.** A board lives at `/#/board/<12-char id>`, and that id is the key, so share links only with people you want on the board.
- **Files** never enter the shared document. Their bytes go over the same data channels in chunks, with backpressure and resume, and are checked against a SHA-256 content hash. Chromium remembers shared files across reloads. Firefox asks the owner to re-pick them when someone needs one.

## Develop
    npm install
    npm run dev          # http://localhost:5173
    npm run lint && npm run typecheck && npm run build

Built with Vite, React 18, TypeScript, Yjs + y-webrtc, Tiptap and perfect-freehand.

## License
[MIT](LICENSE).
