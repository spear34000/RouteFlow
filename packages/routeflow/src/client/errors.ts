/**
 * Error thrown by the RouteFlow client for HTTP or WebSocket failures.
 */
export class ReactiveClientError extends Error {
  /** Machine-readable error code */
  readonly code: string
  /** HTTP status code, if applicable */
  readonly status?: number

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'ReactiveClientError'
    this.code = code
    this.status = status
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
