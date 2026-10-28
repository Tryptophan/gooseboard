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

/**
 * Phones and tablets. Their GPUs (Mali on a Pixel 7a, for one) can load Whisper on WebGPU and
 * then never finish transcribing, so they run it on the CPU.
 */
export function isMobile(): boolean {
  if ((navigator as any).userAgentData?.mobile === true) return true
  // iPads ask for the desktop site: a Mac with a touchscreen is one
  return /Android|iPhone|iPad|Mobi/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
}
