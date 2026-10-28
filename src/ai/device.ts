/** Whether this browser has a usable WebGPU adapter, checked once per page. */
let probed: Promise<boolean> | null = null

export function hasWebGPU(): Promise<boolean> {
  return (probed ??= probe())
}

async function probe(): Promise<boolean> {
  const gpu = (navigator as any).gpu
  if (!gpu) return false
  try {
    // the first request can come back empty while the GPU process starts: ask again plainly, so
    // one hiccup doesn't switch this page to the CPU model (a different, separate download)
    const adapter = (await gpu.requestAdapter({ powerPreference: 'high-performance' })) ?? (await gpu.requestAdapter())
    // a software adapter is slower than ONNX's WASM backend
    return !!adapter && !adapter.isFallbackAdapter && !adapter.info?.isFallbackAdapter
  } catch {
    return false
  }
}
