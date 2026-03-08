import { useRef, useState } from 'react'
import { useCredStore } from '@/store/credStore'
import { fetchAuthFiles } from '@/lib/management'
import { saveConnection, clearConnection, loadConnection } from '@/lib/storage'
import type { ConnectionConfig } from '@/types/api'

export function useConnection() {
  const [error, setError] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const loadRequestIdRef = useRef(0)

  const setConnection = useCredStore((s) => s.setConnection)
  const storeDisconnect = useCredStore((s) => s.disconnect)
  const setFiles = useCredStore((s) => s.setFiles)
  const setLoading = useCredStore((s) => s.setLoading)
  const setRefreshing = useCredStore((s) => s.setRefreshing)

  function nextLoadRequestId(): number {
    loadRequestIdRef.current += 1
    return loadRequestIdRef.current
  }

  function isCurrentLoadRequest(requestId: number): boolean {
    return loadRequestIdRef.current === requestId
  }

  async function loadFilesWithClientGuard(requestId: number): Promise<boolean> {
    const committedClient = useCredStore.getState().client
    if (!committedClient) {
      return false
    }
    const files = await fetchAuthFiles(committedClient)
    if (!isCurrentLoadRequest(requestId)) {
      return false
    }
    if (useCredStore.getState().client !== committedClient) {
      return false
    }
    setFiles(files)
    return true
  }

  async function connect(config: ConnectionConfig): Promise<void> {
    if (!config.endpoint.trim() || !config.managementKey.trim()) {
      setError('Endpoint and management key are required.')
      return
    }
    setError(null)
    setIsConnecting(true)
    setLoading(true)
    const requestId = nextLoadRequestId()

    try {
      setConnection(config)
      const committed = await loadFilesWithClientGuard(requestId)
      if (!committed) return
      saveConnection(config)
    } catch (err) {
      if (!isCurrentLoadRequest(requestId)) return
      storeDisconnect()
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to connect. Check endpoint and key.'
      )
    } finally {
      if (!isCurrentLoadRequest(requestId)) return
      setIsConnecting(false)
      setLoading(false)
    }
  }

  function disconnect(): void {
    nextLoadRequestId()
    clearConnection()
    storeDisconnect()
    setIsConnecting(false)
    setLoading(false)
    setRefreshing(false)
    setError(null)
  }

  async function reconnectFromStorage(): Promise<void> {
    const saved = loadConnection()
    if (!saved) return

    setError(null)
    setIsConnecting(true)
    setLoading(true)
    const requestId = nextLoadRequestId()
    try {
      setConnection(saved)
      await loadFilesWithClientGuard(requestId)
    } catch (err) {
      if (!isCurrentLoadRequest(requestId)) return
      storeDisconnect()
      const message = err instanceof Error ? err.message : 'Failed to reconnect from saved config'
      setError(message)
      console.error('[useConnection] reconnectFromStorage failed:', err)
    } finally {
      if (!isCurrentLoadRequest(requestId)) return
      setIsConnecting(false)
      setLoading(false)
    }
  }

  async function refresh(): Promise<void> {
    const freshClient = useCredStore.getState().client
    if (!freshClient) return
    const requestId = nextLoadRequestId()

    setRefreshing(true)
    try {
      await loadFilesWithClientGuard(requestId)
    } finally {
      if (!isCurrentLoadRequest(requestId)) return
      setRefreshing(false)
    }
  }

  return {
    connect,
    disconnect,
    reconnectFromStorage,
    refresh,
    error,
    isConnecting,
  }
}
