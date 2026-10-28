# Gooseboard

A simple collaborative decentralized workspace for notes, drawings, files and folders, shared live between browsers. No accounts or cloud: open [gooseboard.io](https://gooseboard.io), share the link, and everyone with it edits the same board in real time, peer to peer.

## Features

**On the board**
- **Notes** with a title, rich text and markdown shortcuts (`#` headings, `**bold**`, `-` lists, `[ ]` checklists, code blocks), with four text sizes for any run of text. Edit in place, or open a note in its own window for longer writing.
- **Voice notes**: press the mic in the toolbar (or M) and talk. What you say is written, sentence by sentence and live for everyone, into the selected note, or a new one (in the open folder, if one is open); animated dots show while it's still listening or writing. Press it again to stop.
- **Freehand drawing** with pressure from a stylus, plus an eraser.
- **Files** of any kind: drop, paste or pick them. Images and videos get thumbnails. Images, video, audio, PDFs and text open in a built-in viewer, and big media streams while it loads.
- **Pictures and videos** sit on the board bare, at their own shape: resize them (hold Shift to stretch). Press play on a video to watch it right on the board with the browser's own controls (it streams in, for you only, and still drags anywhere but its control strip); one volume setting is remembered for every video. Hover for buttons to open one large (pictures get a full-screen view with zoom and arrow keys between them) or download it. Pictures stay sharp at any size from a screen-sized copy that's cached in your browser.
- **Folders** to group items, with breadcrumbs and drag-in / drag-out. Notes inside show their titles and can be recoloured there. **Disk folders** share a folder from your computer, browsed live by everyone.
- **Links** as cards or live embeds (YouTube, Vimeo, Spotify, SoundCloud, Google Maps, OpenStreetMap, Google Docs and Drive), switchable per link.
- Select, move, resize, rotate, duplicate, reorder, copy/cut/paste between boards, and undo/redo everything.

**Goosey**
- Goosey, the big goose in the bottom-left corner, holds the menus: *Settings* (theme, storage used by the speech model and cached files, with buttons to clear them), *Transfers* (every file moving to or from you, streamed videos included, with progress, cancel and errors) and *Help* (getting started, and keyboard shortcuts, or touch gestures on phones and tablets).
- While files are moving, a progress ring sits on his shoulder, and closing the tab asks first.

**Voice notes on your device**
- Speech recognition runs entirely in your browser: [Silero VAD](https://github.com/snakers4/silero-vad) picks the speech out of the mic, so pauses and background noise never reach the recogniser (which is what makes it invent words), then Whisper Tiny turns each sentence into text. Your voice never leaves the device.
- Whisper Tiny runs on WebGPU where the browser has it, or on the CPU. The first press asks before it downloads (about 45 MB on the CPU, 120 MB for the GPU) from Hugging Face; once it's cached the mic just starts. Language is detected from what you say first.

**Together**
- Live cursors and names for everyone on the board. Click someone's avatar to follow their view.
- Pick your own name and colour. They're stored in your browser, with no sign-up.
- Edits merge cleanly even when people change the same note at once, and offline edits sync when you reconnect.

**Files without uploads**
- Files stay on the owner's computer and stream straight to whoever opens them.
- Small files (up to 2 MB, or more if you choose so in Goosey's *Settings*) are copied into everyone's browser automatically. Bigger ones are fetched on demand, or press a file's sync button to keep a copy in your browser without saving it to disk. Anyone who has a copy can serve it, so a file stays available when its owner goes offline.
- When nobody online has a file, its card says so and its preview and download buttons are greyed out until someone with it comes back.
- Every card shows whether a file is synced and how many people online have it. Downloads are hash-verified.

**Anywhere**
- Works on desktop, tablets and phones. On touch: drag to pan, pinch to zoom, double-tap to add a note, tap a selected note to edit it, and hold for the menu (hold and drag to select several items).
- With a stylus, the pen draws while your fingers pan and zoom.
- Light and dark themes, a minimap, and keyboard shortcuts throughout (listed in Goosey's *Help* tab).
- **Installable app.** Install it from the download button on the home screen or Goosey's *Settings* (on iPhone and iPad, and in Firefox on Android, those show the browser's own steps). Once loaded it opens offline, and boards open and edit offline too, syncing when people are back. A new version downloads in the background and waits until you press *Reload*.
- In the installed app, share files, pictures, links or text from other apps into Gooseboard (Android), pick a board, and they land in the middle of it. Long-press the app icon for *New board*.

## How it works
- **Peer to peer.** Board data is a [Yjs](https://yjs.dev) document synced over WebRTC between everyone on the board (full mesh) and saved in each browser's IndexedDB. Your board list and profile live in `localStorage`.
- **No server.** Peers find each other through public Nostr relays and WebTorrent trackers, used at the same time, so any one of them being down is fine. Every handshake is encrypted with the board id, so relays see only ciphertext and people without the link can't join. There is no TURN relay, so very strict NATs may fail to connect.
- **Private links.** A board lives at `/#/board/<12-char id>`, and that id is the key, so share links only with people you want on the board.
- **Voice notes** run [transformers.js](https://huggingface.co/docs/transformers.js) in a Web Worker, with weights from Hugging Face's `onnx-community/whisper-tiny` kept in the browser's Cache API. Silero VAD ([vad-web](https://github.com/ricky0123/vad)) runs on the page from an audio worklet; its model and ONNX Runtime's wasm are bundled under `/vad/`, so no CDN is involved. Each utterance the VAD ends is transcribed in turn and appended to the note as a paragraph; known Whisper hallucinations ("thanks for watching", `[BLANK_AUDIO]` and the like) are dropped.
- **Offline app.** One service worker (`public/stream-sw.js`) streams media, precaches the build (the build writes its file list and a content hash into it) and receives the share target. Voice notes' wasm and models still download when first used.
- **Files** never enter the shared document. Their bytes go over the same data channels in chunks, with backpressure and resume, and are checked against a SHA-256 content hash. Chromium remembers shared files across reloads. Firefox asks the owner to re-pick them when someone needs one.

## Develop
    npm install
    npm run dev          # http://localhost:5173
    npm run lint && npm run typecheck && npm run build

Built with Vite, React 18, TypeScript, Yjs + y-webrtc, Tiptap, perfect-freehand and transformers.js.

## License
[MIT](LICENSE).
