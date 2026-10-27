/**
 * Content id for shared files: SHA-256 over the concatenated SHA-256 digests of each 4 MiB block.
 * WebCrypto can't hash incrementally, so a flat SHA-256 would need the whole file in memory;
 * per-block digests let us hash multi-GB files and verify bytes as they stream in, in order.
 */
export const HASH_BLOCK = 4 * 1024 * 1024

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
const sha = (b: Uint8Array) => crypto.subtle.digest('SHA-256', b as BufferSource)

export class Hasher {
  private parts: Uint8Array[] = []
  private pending = 0
  private digests: ArrayBuffer[] = []
  size = 0

  /** Bytes must arrive in order. */
  async update(bytes: Uint8Array) {
    this.size += bytes.length
    let rest = bytes
    while (this.pending + rest.length >= HASH_BLOCK) {
      const take = HASH_BLOCK - this.pending
      this.parts.push(rest.subarray(0, take))
      rest = rest.subarray(take)
      await this.flush()
    }
    if (rest.length) {
      // copy: callers may reuse or transfer the buffer
      this.parts.push(rest.slice())
      this.pending += rest.length
    }
  }

  private async flush() {
    const block = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of this.parts) {
      block.set(p, o)
      o += p.length
    }
    this.parts = []
    this.pending = 0
    this.digests.push(await sha(block))
  }

  async digest(): Promise<string> {
    if (this.pending) await this.flush()
    const all = new Uint8Array(this.digests.length * 32)
    this.digests.forEach((d, i) => all.set(new Uint8Array(d), i * 32))
    return hex(await sha(all))
  }
}

export async function hashBlob(b: Blob): Promise<string> {
  const h = new Hasher()
  for (let off = 0; off < b.size; off += HASH_BLOCK) await h.update(new Uint8Array(await b.slice(off, off + HASH_BLOCK).arrayBuffer()))
  return h.digest()
}
