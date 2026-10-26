/** Only http(s) links are ever rendered as clickable; everything else from peers is ignored. */
export function normalizeUrl(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
