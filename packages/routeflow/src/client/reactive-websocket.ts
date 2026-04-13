import type {
  ReconnectOptions,
  ServerMessage,
  SubscribeMessage,
  SubscriptionCallback,
  SubscriptionRecord,
  Unsubscribe,
} from './types.js'

const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  maxAttempts: 0,
  initialDelayMs: 500,
  backoffFactor: 2,
  maxDelayMs: 30_000,
}

/**
 * Managed WebSocket connection with:
 * - Automatic exponential-backoff reconnection
 * - Subscription restore after reconnect
 * - Path-based fan-out to callbacks
 *
 * Uses the browser-native `WebSocket` API — no Node.js imports.
 */
export class ReactiveWebSocket {
  private ws: WebSocket | null = null
  private readonly subscriptions: Map<string, Set<SubscriptionRecord>> = new Map()
  private readonly reconnectOpts: Required<ReconnectOptions>
  private readonly onError?: (error: { code: string; message: string }) => void

  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private readonly wsUrl: string

  constructor(
    baseUrl: string,
    reconnect?: ReconnectOptions,
    onError?: (error: { code: string; message: string }) => void,
  ) {
    // Convert http(s):// → ws(s)://
    this.wsUrl = baseUrl.replace(/^http/, 'ws')
    this.reconnectOpts = { ...DEFAULT_RECONNECT, ...reconnect }
    this.onError = onError
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to real-time updates for a path.
   * Sends a subscribe message immediately if the socket is open,
   * otherwise queues it for when the connection is established.
   *
   * @returns An unsubscribe function.
   */
  subscribe<T>(
    path: string,
    callback: SubscriptionCallback<T>,
    query?: Record<string, string>,
    onClose?: () => void,
    onError?: (error: { code: string; message: string }) => void,
  ): Unsubscribe {
    if (!this.subscriptions.has(path)) {
      this.subscriptions.set(path, new Set())
    }

    const record: SubscriptionRecord<T> = {
      path,
      query,
      callback: callback as SubscriptionCallback<unknown>,
      onClose,
      onError,
    }
    this.subscriptions.get(path)!.add(record as SubscriptionRecord)

    // Ensure socket is open
    this.ensureConnected()

    // If already open, send subscribe message right away
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(path, query)
    }

    return () => {
      this.subscriptions.get(path)?.delete(record as SubscriptionRecord)
      if (this.subscriptions.get(path)?.size === 0) {
        this.subscriptions.delete(path)
      }
    }
  }

  /**
   * Close the socket and stop all reconnection attempts.
   */
  destroy(): void {
    this.destroyed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onclose = null // prevent reconnect loop
      this.ws.close()
      this.ws = null
    }
    this.subscriptions.clear()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private ensureConnected(): void {
    if (this.destroyed) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.connect()
  }

  private connect(): void {
    if (this.destroyed) return

    let ws: WebSocket
    try {
      ws = new WebSocket(this.wsUrl)
    } catch (err) {
      this.scheduleReconnect()
      return
    }

    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempts = 0
      // Re-subscribe to all active paths (handles reconnect restore)
      for (const [path, records] of this.subscriptions) {
        const query = [...records][0]?.query
        this.sendSubscribe(path, query)
      }
    }

    ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data as string)
    }

    ws.onerror = () => {
      // onerror always fires before onclose; actual retry happens in onclose
    }

    ws.onclose = () => {
      this.ws = null
      // Notify all subscribers that the connection closed
      for (const records of this.subscriptions.values()) {
        for (const record of records) {
          if (record.onClose) {
            try { record.onClose() } catch { /* ignore */ }
          }
        }
      }
      if (!this.destroyed) {
        this.scheduleReconnect()
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return

    const { maxAttempts, initialDelayMs, backoffFactor, maxDelayMs } = this.reconnectOpts

    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      return
    }

    const delay = Math.min(
      initialDelayMs * Math.pow(backoffFactor, this.reconnectAttempts),
      maxDelayMs,
    )

    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private sendSubscribe(path: string, query?: Record<string, string>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const msg: SubscribeMessage = { type: 'subscribe', path, ...(query ? { query } : {}) }
    this.ws.send(JSON.stringify(msg))
  }

  private handleMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    if (!isServerMessage(parsed)) return

    if (parsed.type === 'error') {
      const errInfo = { code: parsed.code, message: parsed.message }
      // Try per-subscription handlers first, fall back to global onError
      let handled = false
      for (const records of this.subscriptions.values()) {
        for (const record of records) {
          if (record.onError) {
            try { record.onError(errInfo) } catch { /* ignore */ }
            handled = true
          }
        }
      }
      if (!handled) {
        if (this.onError) {
          this.onError(errInfo)
        } else {
          console.warn(`[RouteFlow/client] Server error ${parsed.code}: ${parsed.message}`)
        }
      }
      return
    }

    if (parsed.type === 'update') {
      const records = this.subscriptions.get(parsed.path)
      if (!records) return
      for (const record of records) {
        try {
          record.callback(parsed.data)
        } catch (err) {
          console.error('[RouteFlow/client] Subscription callback threw:', err)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isServerMessage(value: unknown): value is ServerMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v['type'] === 'update' || v['type'] === 'error'
}
