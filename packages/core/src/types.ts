/**
 * Supported HTTP methods for @Route decorator.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Per-request context passed into route handlers.
 */
export interface Context {
  /** Path parameters extracted from the URL (e.g. { userId: '123' }) */
  params: Record<string, string>
  /** Query string parameters */
  query: Record<string, string>
  /** Request body (type-narrow before use) */
  body: unknown
  /** Request headers */
  headers: Record<string, string>
}

/**
 * A database change event emitted by a DatabaseAdapter.
 * @template T - Shape of the row being changed
 */
export interface ChangeEvent<T = unknown> {
  /** The table (or collection) that changed */
  table: string
  /** Type of the change */
  operation: 'INSERT' | 'UPDATE' | 'DELETE'
  /** New row state; null for DELETE */
  newRow: T | null
  /** Previous row state; null for INSERT */
  oldRow: T | null
  /** Unix timestamp (ms) when the event was generated */
  timestamp: number
}

/**
 * Contract every database adapter must satisfy.
 * Adapters translate DB-specific change mechanisms into ChangeEvents.
 */
export interface DatabaseAdapter {
  /** Establish the connection to the database. */
  connect(): Promise<void>
  /** Tear down the connection gracefully. */
  disconnect(): Promise<void>
  /**
   * Register a listener for changes on a specific table.
   * @returns An unsubscribe function — call it to stop receiving events.
   */
  onChange(table: string, callback: (event: ChangeEvent) => void): () => void
}

/**
 * Options for the @Reactive decorator.
 */
export interface ReactiveOptions {
  /** Table(s) to watch for changes. */
  watch: string | string[]
  /**
   * Optional filter applied per-subscriber before pushing.
   * Return true to push, false to skip.
   */
  filter?: (event: ChangeEvent, ctx: Context) => boolean
  /** Debounce interval in ms. Multiple changes within this window are collapsed. */
  debounce?: number
}

/**
 * Metadata stored by the @Route decorator on a method.
 */
export interface RouteMetadata {
  method: HttpMethod
  path: string
}

/**
 * Options passed to createApp.
 */
export interface AppOptions {
  /** Database adapter instance. */
  adapter: DatabaseAdapter
  /** Transport mechanism for real-time pushes. Defaults to 'websocket'. */
  transport?: 'websocket' | 'sse'
  /** Port to listen on. Defaults to 3000. */
  port?: number
}

/**
 * Represents a registered reactive endpoint inside the engine.
 */
export interface ReactiveEndpoint {
  /** Registered route path pattern (e.g. '/orders/:userId/live') */
  routePath: string
  options: ReactiveOptions
  /** The async handler function bound to its controller instance */
  handler: (ctx: Context) => Promise<unknown>
}

/** Push function signature used by the engine to deliver updates to a client. */
export type PushFn = (path: string, data: unknown) => void
