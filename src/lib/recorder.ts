/** A recording made for the chat: the audio, its length, and its loudness over time. */
export interface Recorded {
  blob: Blob
  /** ms */
  dur: number
  /** 0..100, BARS of them */
  peaks: number[]
}

/** One recording in progress. */
export interface Recorder {
  /** ms since it started */
  elapsed(): number
  /** loudness so far, 0..1, one every LEVEL_MS */
  levels(): number[]
  /** Stops, and hands over what was recorded (null if nothing was). */
  stop(): Promise<Recorded | null>
  /** Stops and throws it away. */
  cancel(): void
}

/** bars in a voice note's waveform */
export const BARS = 48
/** a voice note stops itself here */
export const MAX_MS = 10 * 60_000
const LEVEL_MS = 50
/** speech is small in Opus: a minute is about 240 KB */
const BITRATE = 32_000
// WebM/Opus in Chrome and Firefox, MP4/AAC in Safari; each plays the others'
const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']

/** Opens the mic and starts recording. `onLimit` runs if it reaches MAX_MS, having stopped. */
export async function record(onLimit: () => void): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true } })
  const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t))
  let rec: MediaRecorder
  try {
    rec = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: BITRATE })
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    throw e
  }
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)

  // loudness, for the live bars and the waveform it leaves behind
  const ctx = new AudioContext()
  const an = ctx.createAnalyser()
  an.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(an)
  const buf = new Float32Array(an.fftSize)
  const levels: number[] = []
  const sample = setInterval(() => {
    an.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    // RMS, eased so quiet speech still shows
    levels.push(Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length)) * 1.6))
  }, LEVEL_MS)

  const t0 = performance.now()
  rec.start()
  const limit = setTimeout(onLimit, MAX_MS)
  const end = () => {
    clearInterval(sample)
    clearTimeout(limit)
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close().catch(() => {})
  }

  return {
    elapsed: () => performance.now() - t0,
    levels: () => levels,
    stop: () =>
      new Promise((resolve) => {
        const dur = Math.round(performance.now() - t0)
        rec.onstop = () => {
          end()
          const blob = new Blob(chunks, { type: (rec.mimeType || mimeType || 'audio/webm').split(';')[0] })
          resolve(blob.size && dur > 300 ? { blob, dur, peaks: peaksOf(levels) } : null)
        }
        if (rec.state === 'inactive') rec.onstop(new Event('stop'))
        else rec.stop()
      }),
    cancel: () => {
      rec.onstop = null
      if (rec.state !== 'inactive') rec.stop()
      end()
    },
  }
}

/** BARS of loudness, the loudest at 100. */
function peaksOf(levels: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < BARS; i++) {
    const a = Math.floor((i * levels.length) / BARS)
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / BARS))
    out.push(Math.max(0, ...levels.slice(a, b)))
  }
  const top = Math.max(...out) || 1
  return out.map((v) => Math.round((v / top) * 100))
}
