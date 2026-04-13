/**
 * Base error class for all RouteFlow errors.
 * Always use this instead of plain `Error` throughout the framework.
 *
 * @example
 * ```ts
 * throw new ReactiveApiError('NOT_FOUND', 'Item not found', 404)
 * throw new ReactiveApiError('FORBIDDEN', 'Access denied', 403)
 * ```
 */
export class ReactiveApiError extends Error {
  /** Machine-readable error code (e.g. 'NOT_FOUND', 'FORBIDDEN') */
  readonly code: string
  /** HTTP status code to send. Defaults to 500. */
  readonly statusCode: number

  constructor(code: string, message: string, statusCode = 500) {
    super(message)
    this.name = 'ReactiveApiError'
    this.code = code
    this.statusCode = statusCode
    // Restore prototype chain (required when extending built-ins in TS)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Convenience factory — 400 Bad Request */
export const badRequest = (message: string, code = 'BAD_REQUEST') =>
  new ReactiveApiError(code, message, 400)

/** Convenience factory — 401 Unauthorized */
export const unauthorized = (message = 'Unauthorized', code = 'UNAUTHORIZED') =>
  new ReactiveApiError(code, message, 401)

/** Convenience factory — 403 Forbidden */
export const forbidden = (message = 'Forbidden', code = 'FORBIDDEN') =>
  new ReactiveApiError(code, message, 403)

/** Convenience factory — 404 Not Found */
export const notFound = (message: string, code = 'NOT_FOUND') =>
  new ReactiveApiError(code, message, 404)
