/**
 * All error codes the RouteFlow client can produce.
 * Use this union for exhaustive error handling:
 *
 * @example
 * ```ts
 * import type { ClientErrorCode } from 'routeflow-api/client'
 *
 * client.subscribe('/items/live', setItems, {
 *   onError: (err) => {
 *     if (err.code === 'NO_REACTIVE_ENDPOINT') {
 *       console.error('Missing @Reactive decorator on that route')
 *     }
 *   },
 * })
 * ```
 */
export type ClientErrorCode =
  // HTTP transport errors
  | 'NETWORK_ERROR'       // fetch() threw (no connection, DNS failure, etc.)
  | 'HTTP_ERROR'          // server responded with non-2xx status
  | 'PARSE_ERROR'         // response body wasn't valid JSON
  // WebSocket / SSE server errors
  | 'INVALID_JSON'        // client sent malformed JSON (WS)
  | 'INVALID_MESSAGE'     // client sent unexpected message shape (WS)
  | 'NO_REACTIVE_ENDPOINT'// subscribed path has no matching @Reactive endpoint
  | 'SSE_MISSING_PATH'    // SSE request is missing the path query param
  | 'SSE_NO_REACTIVE_ENDPOINT' // SSE path has no matching @Reactive endpoint
  | 'SSE_INVALID_PATH'    // SSE path contains invalid percent-encoding
  // Generic
  | (string & Record<never, never>) // allow server-defined codes without losing the named ones

/**
 * Error thrown by the RouteFlow client for HTTP or real-time transport failures.
 */
export class ReactiveClientError extends Error {
  /** Machine-readable error code. See {@link ClientErrorCode} for known values. */
  readonly code: ClientErrorCode
  /** HTTP status code, if applicable (HTTP_ERROR only). */
  readonly status?: number

  constructor(code: ClientErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'ReactiveClientError'
    this.code = code
    this.status = status
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
