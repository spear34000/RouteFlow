import type {
  ClientOptions,
  SubscribeOptions,
  SubscriptionCallback,
  Unsubscribe,
} from './types.js'
import type { ConnectionState } from './reactive-websocket.js'
import { ReactiveClientError } from './errors.js'
import { ReactiveWebSocket } from './reactive-websocket.js'
import { ReactiveSSE } from './reactive-sse.js'

/**
 * RouteFlow client.
 *
 * Provides:
 * - HTTP helpers (`get`, `post`, `put`, `patch`, `del`) backed by the Fetch API
 * - Real-time subscriptions (`subscribe`) via WebSocket or SSE
 *
 * Fully browser-compatible — no Node.js-specific APIs used.
 *
 * @example
 * ```ts
 * const client = createClient('http://localhost:3000')
 *
 * // One-off REST request
 * const orders = await client.get<Order[]>('/orders/123')
 *
 * // Real-time subscription
 * const unsubscribe = client.subscribe<Order[]>('/orders/123/live', (data) => {
 *   console.log('updated:', data)
 * })
 *
 * // Later…
 * unsubscribe()
 * client.destroy()
 * ```
 */
export class ReactiveClient {
  private readonly baseUrl: string
  private readonly defaultHeaders: Record<string, string>
  private socket: ReactiveWebSocket | null = null
  /** path → ReactiveSSE instance (one per path for SSE) */
  private readonly sseStreams: Map<string, ReactiveSSE> = new Map()
  private readonly options: Required<Pick<ClientOptions, 'transport'>> & ClientOptions

  constructor(options: ClientOptions) {
    this.options = { transport: 'websocket', ...options }
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.defaultHeaders = options.headers ?? {}
  }

  // ---------------------------------------------------------------------------
  // HTTP methods
  // ---------------------------------------------------------------------------

  /**
   * Perform a GET request.
   * @param path    - Path relative to baseUrl (e.g. '/orders/123')
   * @param query   - Optional query string parameters
   * @param headers - Per-request header overrides
   */
  async get<T>(
    path: string,
    query?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>('GET', path, undefined, query, headers)
  }

  /** Perform a POST request. */
  async post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('POST', path, body, undefined, headers)
  }

  /** Perform a PUT request. */
  async put<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('PUT', path, body, undefined, headers)
  }

  /** Perform a PATCH request. */
  async patch<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('PATCH', path, body, undefined, headers)
  }

  /**
   * Perform a DELETE request.
   * Named `del` because `delete` is a reserved keyword.
   */
  async del<T>(path: string, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('DELETE', path, undefined, undefined, headers)
  }

  // ---------------------------------------------------------------------------
  // Real-time subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to real-time updates pushed by the server for `path`.
   *
   * The server sends the current state immediately on subscription, so you
   * no longer need a separate `get()` call before `subscribe()`.
   *
   * Uses WebSocket or SSE depending on the `transport` option passed to `createClient`.
   *
   * @param path     - The reactive endpoint path (e.g. '/orders/123/live')
   * @param callback - Invoked with the latest data on each push
   * @param options  - Optional query params, per-subscription error handler, close handler
   * @returns An unsubscribe function — call it to stop receiving updates.
   *
   * @example
   * ```ts
   * const unsub = client.subscribe<Item[]>('/items/live', setItems, {
   *   query: { category: 'fruit' },
   *   onError: (err) => console.error('subscription error:', err),
   *   onClose: () => console.warn('connection lost'),
   * })
   * ```
   */
  subscribe<T>(
    path: string,
    callback: SubscriptionCallback<T>,
    options?: SubscribeOptions<T>,
  ): Unsubscribe {
    const { query, onError, onClose } = options ?? {}
    if (this.options.transport === 'sse') {
      return this.subscribeSSE<T>(path, callback, query)
    }
    return this.subscribeWS<T>(path, callback, query, onClose, onError)
  }

  // ---------------------------------------------------------------------------
  // Connection state
  // ---------------------------------------------------------------------------

  /**
   * Returns the current WebSocket connection state.
   * Always `'disconnected'` when using SSE transport.
   *
   * @example
   * ```ts
   * if (client.getConnectionState() !== 'connected') {
   *   showReconnectingBanner()
   * }
   * ```
   */
  getConnectionState(): ConnectionState {
    return this.socket?.getConnectionState() ?? 'disconnected'
  }

  /**
   * Register a callback that fires whenever the WebSocket connection state changes.
   * Useful for showing "connecting…" / "reconnecting…" UI states.
   *
   * Returns an unsubscribe function to remove the listener.
   *
   * @example
   * ```ts
   * const off = client.onConnectionStateChange((state) => {
   *   setIsOnline(state === 'connected')
   * })
   * // cleanup on unmount:
   * off()
   * ```
   */
  onConnectionStateChange(callback: (state: ConnectionState) => void): Unsubscribe {
    if (!this.socket) {
      // Socket not yet created — create it so we can attach the listener.
      this.socket = new ReactiveWebSocket(this.baseUrl, this.options.reconnect, this.options.onError)
    }
    return this.socket.onConnectionStateChange(callback)
  }

  /**
   * Close the real-time transport and release all resources.
   * Call this when the client is no longer needed (e.g. component unmount).
   */
  destroy(): void {
    this.socket?.destroy()
    this.socket = null
    for (const stream of this.sseStreams.values()) {
      stream.destroy()
    }
    this.sseStreams.clear()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private subscribeWS<T>(
    path: string,
    callback: SubscriptionCallback<T>,
    query?: Record<string, string>,
    onClose?: () => void,
    onError?: (error: { code: string; message: string }) => void,
  ): Unsubscribe {
    if (!this.socket) {
      this.socket = new ReactiveWebSocket(
        this.baseUrl,
        this.options.reconnect,
        this.options.onError,
      )
    }
    return this.socket.subscribe<T>(path, callback, query, onClose, onError)
  }

  private subscribeSSE<T>(
    path: string,
    callback: SubscriptionCallback<T>,
    query?: Record<string, string>,
  ): Unsubscribe {
    // SSE key includes query so different queries get different streams
    const streamKey = query ? `${path}?${new URLSearchParams(query)}` : path

    if (!this.sseStreams.has(streamKey)) {
      this.sseStreams.set(
        streamKey,
        new ReactiveSSE(this.baseUrl, path, query, this.options.reconnect),
      )
    }

    const stream = this.sseStreams.get(streamKey)!
    const unsub = stream.addSubscriber<T>(callback)

    return () => {
      unsub()
      // Clean up the SSE stream when no subscribers remain
      if (stream.subscriberCount === 0) {
        stream.destroy()
        this.sseStreams.delete(streamKey)
      }
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`

    if (query && Object.keys(query).length > 0) {
      url += '?' + new URLSearchParams(query).toString()
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...extraHeaders,
    }

    const init: RequestInit = { method, headers }

    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }

    let response: Response
    try {
      response = await fetch(url, init)
    } catch (err) {
      throw new ReactiveClientError(
        'NETWORK_ERROR',
        `Network request failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!response.ok) {
      // Try to extract a server-sent error payload
      let detail = ''
      try {
        const text = await response.text()
        if (text) {
          try {
            const json = JSON.parse(text) as Record<string, unknown>
            detail = typeof json['message'] === 'string' ? ` — ${json['message']}` : ` — ${text}`
          } catch {
            detail = ` — ${text}`
          }
        }
      } catch {
        // ignore
      }
      throw new ReactiveClientError(
        'HTTP_ERROR',
        `${method} ${path} failed with status ${response.status}${detail}`,
        response.status,
      )
    }

    const contentLength = response.headers.get('content-length')
    if (response.status === 204 || contentLength === '0') {
      return undefined as T
    }

    try {
      return (await response.json()) as T
    } catch {
      throw new ReactiveClientError(
        'PARSE_ERROR',
        `Failed to parse JSON response from ${method} ${path}`,
      )
    }
  }
}

/**
 * Create a new RouteFlow client instance.
 *
 * @example
 * ```ts
 * // WebSocket (default)
 * const client = createClient('http://localhost:3000')
 *
 * // SSE transport
 * const client = createClient('http://localhost:3000', { transport: 'sse' })
 *
 * // With auth header and custom error handler
 * const client = createClient('http://localhost:3000', {
 *   headers: { Authorization: 'Bearer token' },
 *   onError: (err) => console.error('realtime error:', err),
 * })
 * ```
 */
export function createClient(
  baseUrl: string,
  options?: Omit<ClientOptions, 'baseUrl'>,
): ReactiveClient {
  return new ReactiveClient({ baseUrl, ...options })
}
