import type {
  ReconnectOptions,
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
 * Managed SSE connection for a single reactive path subscription.
 *
 * Wraps the browser-native `EventSource` API. Each `ReactiveSSE` instance
 * manages one SSE stream (one subscribed path). Reconnection is handled
 * automatically by `EventSource` for transient failures; we add our own
 * backoff logic for persistent errors.
 *
 * Browser-compatible — no Node.js-specific APIs.
 */
export class ReactiveSSE {
  private source: EventSource | null = null
  private readonly subscribers: Set<SubscriptionRecord> = new Set()
  private readonly reconnectOpts: Required<ReconnectOptions>
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private readonly sseUrl: string

  constructor(
    baseUrl: string,
    private readonly path: string,
    private readonly query: Record<string, string> | undefined,
    reconnect?: ReconnectOptions,
  ) {
    const encodedPath = encodeURIComponent(path)
    const extraParams = query ? '&' + new URLSearchParams(query).toString() : ''
    this.sseUrl = `${baseUrl}/_sse/subscribe?path=${encodedPath}${extraParams}`
    this.reconnectOpts = { ...DEFAULT_RECONNECT, ...reconnect }
    this.connect()
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Add a callback for this SSE stream. */
  addSubscriber<T>(
    callback: SubscriptionCallback<T>,
  ): Unsubscribe {
    const record: SubscriptionRecord<T> = {
      path: this.path,
      query: this.query,
      callback: callback as SubscriptionCallback<unknown>,
    }
    this.subscribers.add(record as SubscriptionRecord)

    return () => {
      this.subscribers.delete(record as SubscriptionRecord)
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }

  /** Close the SSE connection permanently. */
  destroy(): void {
    this.destroyed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.source?.close()
    this.source = null
    this.subscribers.clear()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private connect(): void {
    if (this.destroyed) return

    const source = new EventSource(this.sseUrl)
    this.source = source

    source.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data as string)
    }

    source.onerror = () => {
      // EventSource auto-reconnects on network errors; we only step in after
      // it has given up (readyState === CLOSED).
      if (source.readyState === EventSource.CLOSED) {
        source.close()
        this.source = null
        if (!this.destroyed) this.scheduleReconnect()
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return
    const { maxAttempts, initialDelayMs, backoffFactor, maxDelayMs } = this.reconnectOpts

    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) return

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

  private handleMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as Record<string, unknown>)['type'] !== 'update'
    ) {
      return
    }

    const data = (parsed as Record<string, unknown>)['data']

    for (const record of this.subscribers) {
      try {
        record.callback(data)
      } catch (err) {
        console.error('[RouteFlow/client] SSE subscription callback threw:', err)
      }
    }
  }
}
