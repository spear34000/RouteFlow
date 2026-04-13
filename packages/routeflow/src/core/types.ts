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
 * Generic CRUD interface that any RouteFlow store must satisfy.
 *
 * `RouteTable` (from `routeflow-api/sqlite`) implements this automatically.
 * Custom stores (Postgres, MongoDB, …) implement it manually.
 *
 * @template T - Row shape, must include a numeric `id` field.
 *
 * @example
 * ```ts
 * // Custom Postgres store
 * class ItemStore implements TableStore<Item> {
 *   async list() { ... }
 *   async get(id) { ... }
 *   async create(data) { ... }
 *   async update(id, data) { ... }
 *   async delete(id) { ... }
 * }
 * ```
 */
export interface TableStore<T extends { id: number }> {
  /** Return all rows. */
  list(): Promise<T[]>
  /** Return one row by id, or null. */
  get(id: number): Promise<T | null>
  /** Insert a row and return it. */
  create(data: Omit<T, 'id'>): Promise<T>
  /** Update columns on a row and return the updated row, or null if not found. */
  update(id: number, data: Partial<Omit<T, 'id'>>): Promise<T | null>
  /** Delete a row. Returns true if a row was deleted. */
  delete(id: number): Promise<boolean>
  /** Seed with initial rows if the store is empty. */
  seed?(rows: Omit<T, 'id'>[]): Promise<void>
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
 * Middleware function — runs before every HTTP route handler.
 *
 * Call `next()` to continue the chain; throw a `ReactiveApiError` to abort.
 *
 * @example
 * ```ts
 * app.use(async (ctx, next) => {
 *   if (!ctx.headers['authorization']) throw unauthorized()
 *   await next()
 * })
 * ```
 */
export type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void>

/**
 * CORS origin configuration.
 * - `true` — allow all origins
 * - `string` — single allowed origin (e.g. `'https://myapp.com'`)
 * - `string[]` — multiple allowed origins
 */
export type CorsOrigin = boolean | string | string[]

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
  /**
   * CORS configuration.
   * - `true` (default) — allow all origins during development
   * - `false` — disable CORS headers
   * - `'https://myapp.com'` — single allowed origin
   * - `['https://a.com', 'https://b.com']` — multiple origins
   */
  cors?: CorsOrigin
  /**
   * Maximum HTTP request body size in bytes.
   * Defaults to 1 048 576 (1 MiB).
   */
  bodyLimit?: number
  /**
   * Enable Fastify request/response logging.
   * Useful in development; disable in test environments.
   * Defaults to false.
   */
  logger?: boolean
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
