/**
 * Diagnostics: a timestamped log of what the app does (kept since page load, in memory only)
 * and a snapshot of everything it runs on, copied from Help as one JSON blob to send in a bug
 * report. Modules add their own sections with `diagSection`, so this file imports none of them.
 * Ids, names, and anything people wrote are scrubbed before it leaves the page.
 */

export interface DiagEntry {
  /** ms since page load */
  t: number
  cat: string
  msg: string
  data?: unknown
}

const MAX = 1500
const entries: DiagEntry[] = []
let dropped = 0

export function diag(cat: string, msg: string, data?: unknown) {
  if (entries.length >= MAX) {
    entries.shift()
    dropped++
  }
  entries.push({ t: Math.round(performance.now()), cat, msg, ...(data !== undefined && { data: plain(data) }) })
}

/** Errors and other objects as JSON-friendly values, so the log doesn't hold on to them. */
function plain(v: unknown, depth = 0): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.split('\n').slice(0, 8).join('\n') }
  if (typeof Event !== 'undefined' && v instanceof Event) return { type: v.type }
  if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? String(v) : v
  if (depth > 4) return '…'
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => plain(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v).slice(0, 80)) if (typeof x !== 'function') out[k] = plain(x, depth + 1)
  return out
}

const text = (args: unknown[]) => args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : safeJSON(a))).join(' ').slice(0, 2000)
function safeJSON(v: unknown) {
  try {
    return JSON.stringify(plain(v))
  } catch {
    return String(v)
  }
}

let installed = false
/** Call first thing: records console warnings and errors, uncaught errors, and unhandled rejections. */
export function installDiag() {
  if (installed) return
  installed = true
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      diag(`console.${level}`, text(args))
      orig(...args)
    }
  }
  window.addEventListener('error', (e) => diag('uncaught', e.message || 'error', { source: e.filename, line: e.lineno, col: e.colno, error: e.error }))
  window.addEventListener('unhandledrejection', (e) => diag('unhandledrejection', text([e.reason])))
  diag('app', 'page load', { commit: __COMMIT__, mode: import.meta.env.MODE })
}

type Section = () => unknown
const sections = new Map<string, Section>()
/** strings to hide in the dump (board ids, names, and so on), fetched when it's collected */
const secretSources = new Set<() => Iterable<string | undefined>>()

export function diagSection(name: string, get: Section) {
  sections.set(name, get)
}
export function diagSecrets(get: () => Iterable<string | undefined>) {
  secretSources.add(get)
}

/** A short stable stand-in for an id or name: the same input gives the same tag within a dump. */
export function tag(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return `#${(h >>> 0).toString(16).padStart(8, '0').slice(0, 6)}`
}

async function settle(get: Section, ms = 8000): Promise<unknown> {
  try {
    return plain(
      await Promise.race([
        Promise.resolve().then(get),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
      ]),
    )
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** Everything, as pretty JSON with secrets replaced by tags. */
export async function collectDiag(): Promise<string> {
  const out: Record<string, unknown> = { generated: new Date().toISOString(), uptimeMs: Math.round(performance.now()) }
  const results = await Promise.all([...sections].map(async ([name, get]) => [name, await settle(get)] as const))
  for (const [name, v] of results) out[name] = v
  out.log = { dropped, entries: entries.map((e) => plain(e)) }
  let json = JSON.stringify(out, null, 1)
  const secrets = new Set<string>()
  for (const src of secretSources) {
    try {
      for (const s of src()) if (s && s.length >= 3) secrets.add(s)
    } catch {
      /* a section's secrets aren't worth failing the dump over */
    }
  }
  // longest first, so a name containing another is replaced whole
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    const enc = JSON.stringify(s).slice(1, -1)
    json = json.split(enc).join(tag(s))
    // ids also turn up URL-encoded (in links and console messages)
    const url = encodeURIComponent(s)
    if (url !== enc) json = json.split(url).join(tag(s))
  }
  return json
}
