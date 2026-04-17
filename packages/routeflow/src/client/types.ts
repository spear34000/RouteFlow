/**
 * Options passed to `createClient`.
 */
export interface ClientOptions {
  /**
   * Base URL of the RouteFlow server (e.g. 'http://localhost:3000').
   * Trailing slash is trimmed automatically.
   */
  baseUrl: string

  /**
   * Default headers added to every HTTP request.
   */
  headers?: Record<string, string>

  /**
   * Real-time transport mechanism.
   * - `'websocket'` (default) — uses WebSocket; full-duplex, supported everywhere.
   * - `'sse'` — uses Server-Sent Events; simpler, works over plain HTTP/1.1.
   */
  transport?: 'websocket' | 'sse'

  /**
   * Reconnect / backoff settings for the real-time transport.
   */
  reconnect?: ReconnectOptions

  /**
   * Global error handler called when the server sends an error message
   * over the real-time channel, or when a subscription callback throws.
   */
  onError?: (error: { code: string; message: string }) => void

  /**
   * Called when any HTTP request receives a **401 Unauthorized** response.
   *
   * Return a new bearer token string to **retry the request once** with an
   * updated `Authorization: Bearer <token>` header — ideal for mobile apps
   * where JWTs expire during long sessions.
   *
   * Return `null` or `undefined` to propagate the 401 error normally.
   *
   * @example
   * ```ts
   * const client = createClient('https://api.example.com', {
   *   headers: { Authorization: `Bearer ${await getStoredToken()}` },
   *   onUnauthorized: async () => {
   *     const newToken = await refreshAccessToken()
   *     return newToken  // retry with this token
   *   },
   * })
   * ```
   */
  onUnauthorized?: () => Promise<string | null | undefined>
}

/**
 * Exponential-backoff reconnect configuration.
 */
export interface ReconnectOptions {
  /** Maximum number of reconnect attempts. 0 = unlimited. Default: 0 */
  maxAttempts?: number
  /** Initial delay in ms before first retry. Default: 500 */
  initialDelayMs?: number
  /** Multiplier applied to the delay on each failure. Default: 2 */
  backoffFactor?: number
  /** Maximum delay cap in ms. Default: 30_000 */
  maxDelayMs?: number
}

/**
 * Options passed to `subscribe()`.
 */
export interface SubscribeOptions<T> {
  /** Query string params forwarded with the subscription request. */
  query?: Record<string, string>
  /** Called when the server sends an error for this subscription. */
  onError?: (error: { code: string; message: string }) => void
  /** Called when the underlying connection closes unexpectedly. */
  onClose?: () => void
  /** Called on each data update. Alias for the callback positional arg. */
  onData?: SubscriptionCallback<T>
}

/**
 * Message sent by the client to subscribe to a reactive path.
 */
export interface SubscribeMessage {
  type: 'subscribe'
  path: string
  query?: Record<string, string>
}

/**
 * Message pushed by the server when data changes.
 */
export interface UpdateMessage {
  type: 'update'
  path: string
  data: unknown
}

/**
 * Error message sent by the server.
 */
export interface ServerErrorMessage {
  type: 'error'
  code: string
  message: string
}

export type ServerMessage = UpdateMessage | ServerErrorMessage

/**
 * Callback invoked when new data is pushed for a subscribed path.
 */
export type SubscriptionCallback<T> = (data: T) => void

/**
 * Call this function to cancel a subscription.
 */
export type Unsubscribe = () => void

/**
 * Internal subscription record.
 */
export interface SubscriptionRecord<T = unknown> {
  path: string
  query?: Record<string, string>
  callback: SubscriptionCallback<T>
  onClose?: () => void
  onError?: (error: { code: string; message: string }) => void
}
