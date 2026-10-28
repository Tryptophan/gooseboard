import { diag, diagSection } from '../lib/diag'
import { engine, Engine } from './engine'
import { isDownloaded, whisperSpec, WHISPER, type ModelSpec } from './models'
import { micStream, VAD_OPTIONS, voice } from './voice'

/**
 * The voice self-test in Help: Whisper on a known clip on each backend in turn, in its own
 * worker with deadlines, then 5 s of the mic through Silero VAD. Each step is logged, and the
 * results go into the diagnostics.
 */

/** transformers.js's own sample (JFK's inaugural address), from Hugging Face like the models */
const CLIP = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav'
const EXPECT = /fellow americans/i
const RATE = 16_000
/** a load fails when the download has stalled this long, or initialising has */
const STALL_MS = 120_000
const RUN_MS = 120_000
const LISTEN_MS = 5_000

export interface SelfTestStep {
  step: string
  ok: boolean
  ms: number
  [k: string]: unknown
}

let last: { at: string; steps: SelfTestStep[] } | null = null
diagSection('selfTest', () => last ?? 'not run')

/** What the test is doing (or found), outliving the menu it was started from */
let status: { running: boolean; text: string } = { running: false, text: '' }
const listeners = new Set<() => void>()
export const subscribeSelfTest = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
export const getSelfTest = () => status
const setStatus = (running: boolean, text: string) => {
  status = { running, text }
  listeners.forEach((l) => l())
}

/** The model voice notes use here first, then the other where the browser has WebGPU at all. */
export async function selfTestSpecs(): Promise<ModelSpec[]> {
  const chosen = await whisperSpec()
  const other = chosen === WHISPER.wasm ? WHISPER.webgpu : WHISPER.wasm
  return other.device === 'webgpu' && !(navigator as any).gpu ? [chosen] : [chosen, other]
}

/** MB still to download for the self-test. */
export async function selfTestDownloadMB(): Promise<number> {
  let mb = 2
  for (const s of await selfTestSpecs()) if (!(await isDownloaded(s))) mb += s.mb
  return mb
}

async function clip(): Promise<Float32Array> {
  const res = await fetch(CLIP)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  // decoded straight to Whisper's 16 kHz mono; no audio device involved
  const ctx = new OfflineAudioContext(1, 1, RATE)
  const audio = await ctx.decodeAudioData(buf)
  return audio.getChannelData(0).slice()
}

/** Rejects if `p` hasn't settled after `ms`, or after `ms` without `poke()` being called. */
function deadline<T>(p: Promise<T>, ms: number, what: string): { p: Promise<T>; poke: () => void } {
  let timer: ReturnType<typeof setTimeout>
  let reject!: (e: Error) => void
  const late = new Promise<never>((_, r) => (reject = r))
  const poke = () => {
    clearTimeout(timer)
    timer = setTimeout(() => reject(new Error(`${what}: no answer after ${Math.round(ms / 1000)} s`)), ms)
  }
  poke()
  return { p: Promise.race([p, late]).finally(() => clearTimeout(timer)), poke }
}

async function step(steps: SelfTestStep[], name: string, onStatus: (s: string) => void, fn: () => Promise<Record<string, unknown> | void>) {
  onStatus(`${name}…`)
  diag('selftest', name)
  const t0 = performance.now()
  let r: SelfTestStep
  try {
    r = { step: name, ok: true, ms: 0, ...(await fn()) }
  } catch (e) {
    r = { step: name, ok: false, ms: 0, error: e instanceof Error ? e.message : String(e) }
  }
  r.ms = Math.round(performance.now() - t0)
  diag('selftest', `${name}: ${r.ok ? 'ok' : 'failed'}`, r)
  steps.push(r)
  return r
}

export async function runSelfTest(): Promise<void> {
  if (status.running) return
  const onStatus = (text: string) => setStatus(true, text)
  const steps: SelfTestStep[] = []
  last = { at: new Date().toISOString(), steps }
  // the shared engine may hold a model on the GPU: free it so the tests run alone
  await voice.stop()
  engine.reset()

  const sample: { audio?: Float32Array } = {}
  await step(steps, 'fetch sample', onStatus, async () => {
    const audio = (sample.audio = await clip())
    return { seconds: +(audio.length / RATE).toFixed(2) }
  })

  for (const spec of await selfTestSpecs()) {
    const audio = sample.audio
    if (!audio) break
    const eng = new Engine(`selftest.${spec.device}`)
    const cached = await isDownloaded(spec)
    const load = await step(steps, `${spec.device}: load`, onStatus, async () => {
      let pct = -1
      const d = deadline(
        eng.load(spec, (l, t) => {
          d.poke()
          const now = t ? Math.round((l / t) * 100) : -1
          if (now !== pct) onStatus(`${spec.device}: downloading ${(pct = now)}%`)
        }),
        STALL_MS,
        'load',
      )
      await d.p
      return { spec: spec.id, wasCached: cached }
    })
    if (load.ok) {
      await step(steps, `${spec.device}: transcribe`, onStatus, async () => {
        const input = audio.slice()
        const out = await deadline(eng.run<{ text: string; language?: string }>(spec, input, { task: 'transcribe', language: 'auto' }), RUN_MS, 'transcribe').p
        // the sample is public, so its transcript can go in the report
        return { language: out.language, text: out.text, matches: EXPECT.test(out.text) }
      })
    }
    eng.reset()
  }

  await step(steps, 'vad: listen 5 s', onStatus, async () => {
    const { MicVAD } = await import('@ricky0123/vad-web')
    let frames = 0
    let peak = 0
    const events: string[] = []
    const t0 = performance.now()
    let first: number | null = null
    const vad = await MicVAD.new({
      ...VAD_OPTIONS,
      getStream: () => micStream('selftest'),
      onFrameProcessed: (p) => {
        frames++
        peak = Math.max(peak, p.isSpeech)
        first ??= Math.round(performance.now() - t0)
      },
      onSpeechStart: () => void events.push('start'),
      onSpeechRealStart: () => void events.push('confirmed'),
      onVADMisfire: () => void events.push('misfire'),
      onSpeechEnd: (a) => void events.push(`end ${(a.length / RATE).toFixed(1)} s`),
    })
    const ready = Math.round(performance.now() - t0)
    onStatus('Listening for 5 s: say something…')
    await new Promise((r) => setTimeout(r, LISTEN_MS))
    await vad.pause().catch(() => {})
    await vad.destroy().catch(() => {})
    if (!frames) throw new Error(`no audio frames in ${LISTEN_MS / 1000} s (ready after ${ready} ms${vad.errored ? `, ${vad.errored}` : ''})`)
    return { readyMs: ready, firstFrameMs: first, frames, framesPerSecond: +(frames / (LISTEN_MS / 1000)).toFixed(1), peak: +peak.toFixed(2), events, errored: vad.errored }
  })

  const failed = steps.filter((s) => !s.ok)
  setStatus(false, failed.length ? `Failed: ${failed.map((s) => s.step).join(', ')}. Copy the diagnostics to send them.` : 'Everything worked. Copy the diagnostics to send them.')
}
