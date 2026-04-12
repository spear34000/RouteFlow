/**
 * Base error class for all RouteFlow errors.
 * Always use this instead of plain `Error` throughout the framework.
 */
export class ReactiveApiError extends Error {
  /** Machine-readable error code (e.g. 'ADAPTER_NOT_CONNECTED', 'INVALID_ROUTE') */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ReactiveApiError'
    this.code = code
    // Restore prototype chain (required when extending built-ins in TS)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
