const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Uniform base62 string from crypto randomness (rejection sampling, no modulo bias). */
export function randomId(len: number): string {
  let out = ''
  const buf = new Uint8Array(len * 2)
  while (out.length < len) {
    crypto.getRandomValues(buf)
    for (let i = 0; i < buf.length && out.length < len; i++) {
      if (buf[i] < 248) out += ALPHABET[buf[i] % 62] // 248 = 62 * 4
    }
  }
  return out
}

/** 12 chars of base62 ≈ 71 bits: the id is also the room password. Older 8-char ids still work. */
export const newBoardId = () => randomId(12)
export const newItemId = () => randomId(12)
export const newUserId = () => randomId(16)

export const isValidBoardId = (s: string | undefined): s is string => !!s && /^[0-9A-Za-z_-]{1,64}$/.test(s)

/** Accepts a bare id or any gooseboard URL containing `/board/<id>`. */
export function parseBoardRef(input: string): string | null {
  const t = input.trim()
  const m = t.match(/board\/([0-9A-Za-z_-]{1,64})/)
  if (m) return m[1]
  return isValidBoardId(t) ? t : null
}
