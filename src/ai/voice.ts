import type { MicVAD, RealTimeVADOptions } from '@ricky0123/vad-web'
import * as Y from 'yjs'
import type { Vec } from '../lib/geometry'
import { diag, diagSection } from '../lib/diag'
import { isStaleChunk, toast } from '../lib/toast'
import type { BoardStore } from '../model/board'
import { engine } from './engine'
import { whisperSpec, type ModelSpec } from './models'

const SAMPLE_RATE = 16_000
const NOTE = { w: 300, h: 260, color: '#e3d4ff' }
/** Silero's model, its audio worklet and ONNX Runtime's wasm, copied into the build by vite.config.ts */
const ASSETS = `${import.meta.env.BASE_URL}vad/`

/** Silero VAD's settings: a little stricter than the defaults, so breath and keyboard noise stay out */
const VAD_OPTIONS: Partial<RealTimeVADOptions> = {
  model: 'v5',
  baseAssetPath: ASSETS,
  onnxWASMBasePath: ASSETS,
  positiveSpeechThreshold: 0.6,
  negativeSpeechThreshold: 0.4,
  minSpeechMs: 400,
  redemptionMs: 700,
  preSpeechPadMs: 300,
  submitUserSpeechOnPause: true,
}

/** The mic as vad-web asks for it, with what the browser actually gave logged. */
async function micStream(label: string): Promise<MediaStream> {
  const t0 = performance.now()
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true } })
  const track = stream.getAudioTracks()[0]
  const { deviceId: _d, groupId: _g, ...settings } = track?.getSettings() ?? {}
  diag(label, 'mic open', { ms: Math.round(performance.now() - t0), label: track?.label ? 'named' : 'unnamed', settings })
  return stream
}

/**
 * What Whisper says over noise and breath that VAD let through: captions from its training data.
 * Matched against the whole utterance, ignoring case and punctuation.
 */
const HALLUCINATIONS = [
  /^(thanks|thank you) (so much )?for watching/,
  /^(please )?(like and )?subscribe/,
  /^(subtitles|captions|transcription) (by|from)/,
  /amara\.org/,
  /^you$/,
  /^(bye|okay|so|um|uh|hmm)$/,
]

/** "[BLANK_AUDIO]", "(music)", "♪♪", "..." and the like */
const NOISE = /^\s*(?:[[(].*[\])]|[♪\s.…-]*)\s*$/

function clean(text: string): string {
  const t = text.trim()
  if (NOISE.test(t)) return ''
  const bare = t.toLowerCase().replace(/[^\p{L}\p{N}\s.]/gu, '').replace(/\.+$/, '').trim()
  if (!bare || HALLUCINATIONS.some((h) => h.test(bare))) return ''
  // a decoding loop: the same word over and over
  return t.replace(/\b(\S+)(?:\s+\1\b){3,}/gi, '$1')
}

export type VoiceState = { phase: 'idle' } | { phase: 'starting' } | { phase: 'listening'; speaking: boolean; note: string }

/** One press of the mic, from start to the last utterance written. */
interface Recording {
  store: BoardStore
  spec: ModelSpec
  note: string
  /** writing into a note that was already there: it stays even if nothing is heard */
  existing: boolean
  vad: MicVAD | null
  /** detected from the first utterance long enough to tell, then kept */
  language: string
  wrote: number
  /** utterances waiting for Whisper, in order, and how many */
  queue: Promise<void>
  pending: number
  live: boolean
  /** VAD frames since the last heartbeat in the log, and the highest speech probability among them */
  frames: number
  peak: number
  beat: number
}

/**
 * Voice notes: the toolbar mic. Silero VAD (on the main thread, from the mic) cuts the speech
 * out of the silence, so Whisper only ever hears someone talking, and each utterance is
 * transcribed in turn and appended to one note as a paragraph. One recording per tab.
 */
class Voice {
  private state: VoiceState = { phase: 'idle' }
  private listeners = new Set<() => void>()
  private rec: Recording | null = null
  /** bumped by stop(), so a start still waiting on the mic gives up */
  private seq = 0

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  getState = () => this.state
  /** note id -> utterances heard but not yet written; outlives the recording until they're done */
  private waitingFor = new Map<string, number>()

  /** True while `note` has speech coming: someone is talking into it, or Whisper is still working. */
  waiting(note: string): boolean {
    const st = this.state
    return (st.phase === 'listening' && st.note === note && st.speaking) || !!this.waitingFor.get(note)
  }
  private set(s: VoiceState) {
    this.state = s
    this.listeners.forEach((l) => l())
  }

  /**
   * Starts listening into `into` (an existing note), or else a new note at `at` (or inside
   * `parent`). Loads the model if it isn't yet.
   */
  async start(store: BoardStore, at: Vec, parent: string | null, into?: string) {
    if (this.state.phase !== 'idle') return
    const seq = ++this.seq
    this.set({ phase: 'starting' })
    const t0 = performance.now()
    let rec: Recording
    try {
      const spec = await whisperSpec()
      diag('voice', 'start', { spec: spec.id, into: !!into })
      await engine.load(spec)
      const { MicVAD } = await import('@ricky0123/vad-web')
      if (seq !== this.seq) return
      rec = { store, spec, note: '', existing: false, vad: null, language: 'auto', wrote: 0, queue: Promise.resolve(), pending: 0, live: true, frames: 0, peak: 0, beat: performance.now() }
      rec.vad = await MicVAD.new({
        ...VAD_OPTIONS,
        getStream: () => micStream('voice'),
        onFrameProcessed: (p) => this.frame(rec, p.isSpeech),
        onSpeechStart: () => diag('voice', 'vad speech start'),
        onSpeechRealStart: () => {
          diag('voice', 'vad speech confirmed')
          this.speaking(rec, true)
        },
        onVADMisfire: () => {
          diag('voice', 'vad misfire')
          this.speaking(rec, false)
        },
        onSpeechEnd: (audio) => {
          diag('voice', 'vad speech end', { seconds: +(audio.length / SAMPLE_RATE).toFixed(2), queued: rec.pending })
          // marked waiting before speaking ends, so the dots don't flicker off in between
          this.waitingFor.set(rec.note, ++rec.pending)
          this.speaking(rec, false)
          rec.queue = rec.queue.then(() => this.hear(rec, audio)).finally(() => {
            if (--rec.pending) this.waitingFor.set(rec.note, rec.pending)
            else this.waitingFor.delete(rec.note)
            this.set(this.state)
          })
        },
      })
      if (seq !== this.seq) return void rec.vad.destroy()
      diag('voice', 'listening', { ms: Math.round(performance.now() - t0), errored: rec.vad.errored })
    } catch (e) {
      diag('voice', 'start failed', { ms: Math.round(performance.now() - t0), error: e })
      if (seq !== this.seq) return
      this.set({ phase: 'idle' })
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      if (isStaleChunk(e)) return toast('Gooseboard has been updated: reload to use voice notes', { label: 'Reload', run: () => location.reload() })
      toast(denied ? 'Gooseboard needs the microphone for voice notes' : `Couldn’t start the microphone: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (into && store.getSnapshot().all.get(into)?.type === 'note') {
      rec.note = into
      rec.existing = true
    } else {
      // centred on the view (or wherever, inside a folder, where position doesn't show)
      const pos = { x: at.x - NOTE.w / 2, y: at.y - NOTE.h / 2 }
      store.undo.stopCapturing()
      rec.note = store.add({ type: 'note', color: NOTE.color, x: Math.round(pos.x), y: Math.round(pos.y), w: NOTE.w, h: NOTE.h, parent })
      store.undo.stopCapturing()
    }
    this.rec = rec
    this.set({ phase: 'listening', speaking: false, note: rec.note })
  }

  /** Stops the mic. What's already been heard still gets written; a note left empty is removed. */
  async stop() {
    this.seq++
    const rec = this.rec
    this.rec = null
    this.set({ phase: 'idle' })
    if (!rec) return
    diag('voice', 'stop', { wrote: rec.wrote, pending: rec.pending })
    rec.live = false
    // pausing hands over the utterance in progress (submitUserSpeechOnPause)
    await rec.vad?.pause().catch(() => {})
    void rec.vad?.destroy().catch(() => {})
    await rec.queue
    if (!rec.wrote && !rec.existing && rec.store.getSnapshot().all.has(rec.note)) {
      rec.store.undo.stopCapturing()
      rec.store.remove([rec.note])
    }
  }

  /** Every VAD frame (about 30 a second): a heartbeat in the log every 10 s shows the mic is still flowing. */
  private frame(rec: Recording, p: number) {
    rec.frames++
    rec.peak = Math.max(rec.peak, p)
    const now = performance.now()
    if (now - rec.beat < 10_000) return
    diag('voice', 'vad frames', { frames: rec.frames, seconds: Math.round((now - rec.beat) / 1000), peak: +rec.peak.toFixed(2) })
    rec.frames = 0
    rec.peak = 0
    rec.beat = now
  }

  private speaking(rec: Recording, speaking: boolean) {
    const st = this.state
    if (rec === this.rec && st.phase === 'listening' && st.speaking !== speaking) this.set({ ...st, speaking })
  }

  private async hear(rec: Recording, audio: Float32Array) {
    // the note was deleted (or undone) meanwhile: nothing to write into
    if (!rec.store.getSnapshot().all.has(rec.note)) {
      if (rec === this.rec) void this.stop()
      return
    }
    let text: string
    try {
      const options = { task: 'transcribe', language: rec.language, ...(audio.length > 30 * SAMPLE_RATE && { chunk_length_s: 30, stride_length_s: 5 }) }
      const out = await engine.run<{ text: string; language?: string }>(rec.spec, audio, options)
      // a second or more of speech is enough to tell the language
      if (rec.language === 'auto' && out.language && audio.length >= SAMPLE_RATE) rec.language = out.language
      text = clean(out.text)
      diag('voice', 'heard', { language: out.language, chars: out.text?.length ?? 0, kept: text.length })
    } catch (e) {
      if (rec.live) toast(`Couldn’t transcribe that: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (text) this.append(rec, text)
  }

  private append(rec: Recording, text: string) {
    const f = rec.store.noteFragment(rec.note)
    if (!f) return
    rec.store.doc.transact(() => {
      // the editor may have put an empty paragraph in the new note: replace it
      const only = f.length === 1 ? f.get(0) : null
      if (only instanceof Y.XmlElement && only.nodeName === 'paragraph' && only.length === 0) f.delete(0, 1)
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText(text)])
      f.insert(f.length, [p])
    }, 'gooseboard-system')
    rec.wrote++
  }
}

export const voice = new Voice()

diagSection('voice', () => ({ state: voice.getState().phase, engine: engine.status() }))
