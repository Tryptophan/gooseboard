/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALING_URLS?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
