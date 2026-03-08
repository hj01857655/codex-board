interface ImportMetaEnv {
  readonly DEV: boolean
  readonly VITE_PROXY_MODE?: string
  readonly VITE_ENDPOINT?: string
  readonly VITE_MANAGEMENT_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
