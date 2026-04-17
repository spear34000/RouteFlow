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
  /**
   * Unique request identifier for distributed tracing.
   *
   * Taken from the incoming `X-Request-ID` header when present; otherwise a
   * fresh UUID is generated per request.  Include this in logs and error
   * responses to correlate events across services.
   *
   * Always set for HTTP requests via `.flow()` and `.register()`.
   * Not set for reactive WebSocket/SSE subscriptions (use the `clientId`
   * provided to `onConnect` instead).
   *
   * @example
   * ```ts
   * app.use(async (ctx, next) => {
   *   console.log(`[${ctx.requestId}] ${ctx.headers['x-path']}`)
   *   await next()
   * })
   * ```
   */
  requestId?: string
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
/** Query options for TableStore.list(). */
export interface StoreListOptions<T extends { id: number }> {
  /** Filter rows by exact column value matches. */
  where?: Partial<T>
  /** Sort by a column name. Default: 'id'. */
  orderBy?: string
  /** Sort direction. Default: 'asc'. */
  order?: 'asc' | 'desc'
  /** Maximum rows to return. */
  limit?: number
  /**
   * Skip the first N rows (page-based pagination).
   * Prefer `after` for large tables.
   */
  offset?: number
  /**
   * Cursor-based pagination: return rows whose `id` is strictly greater than `after`.
   * Efficient even at millions of rows because it uses the primary-key index.
   */
  after?: number
}

/**
 * Symbol used by stores to carry a reference to their parent DatabaseAdapter.
 * `flow()` reads this symbol to auto-discover adapters without requiring
 * `createApp({ adapter })` to be set explicitly.
 */
export const ADAPTER_SYMBOL = Symbol.for('routeflow.adapter')

export interface TableStore<T extends { id: number }> {
  /**
   * Return rows matching the given options.
   * `options` is optional — omitting it returns all rows (existing implementations
   * with `list(): Promise<T[]>` continue to work without any changes).
   */
  list(options?: StoreListOptions<T>): Promise<T[]>
  /** Return one row by id, or null. */
  get(id: number): Promise<T | null>
  /**
   * Return multiple rows by a list of ids in a single query.
   * Result order matches the `ids` array; missing rows appear as `null`.
   *
   * Optional — stores that implement this enable `?include=` relation loading
   * to use a single `WHERE id IN (...)` query instead of N parallel `get()` calls.
   *
   * @example
   * ```ts
   * const rows = await users.getMany([1, 2, 3])
   * // → [{ id: 1, ... }, null, { id: 3, ... }]  (2 was deleted)
   * ```
   */
  getMany?(ids: number[]): Promise<(T | null)[]>
  /** Insert a row and return it. */
  create(data: Omit<T, 'id'>): Promise<T>
  /** Update columns on a row and return the updated row, or null if not found. */
  update(id: number, data: Partial<Omit<T, 'id'>>): Promise<T | null>
  /** Delete a row. Returns true if a row was deleted. */
  delete(id: number): Promise<boolean>
  /** Seed with initial rows if the store is empty. */
  seed?(rows: Omit<T, 'id'>[]): Promise<void>
  /** Parent adapter, auto-discovered by flow(). Set by PostgresStore/RouteStore. */
  readonly [ADAPTER_SYMBOL]?: DatabaseAdapter
  /** Optional table/collection name for reactive dependency inference. */
  readonly tableName?: string
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
 * Lifecycle hooks for CRUD operations in a flow.
 * Each hook receives the data and the request context.
 */
export interface FlowHooks {
  /** Transform body before store.create(). Return the (possibly mutated) data. */
  beforeCreate?: (data: Record<string, unknown>, ctx: Context) => Record<string, unknown> | Promise<Record<string, unknown>>
  /** Called after store.create() succeeds. */
  afterCreate?:  (row: unknown, ctx: Context) => void | Promise<void>
  /** Transform body before store.update(). Return the (possibly mutated) data. */
  beforeUpdate?: (data: Record<string, unknown>, ctx: Context) => Record<string, unknown> | Promise<Record<string, unknown>>
  /** Called after store.update() succeeds. */
  afterUpdate?:  (row: unknown, ctx: Context) => void | Promise<void>
  /** Called before store.delete(). Throw to abort the delete. */
  beforeDelete?: (id: number, ctx: Context) => void | Promise<void>
  /** Called after store.delete() succeeds. */
  afterDelete?:  (id: number, ctx: Context) => void | Promise<void>
}

/**
 * Defines a join relation for use with `?include=<name>` query parameter.
 */
export interface FlowRelation {
  /** The store whose rows should be joined in. */
  store: TableStore<any>  // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Column name on the current table that holds the foreign key. */
  foreignKey: string
  /**
   * Table(s) to watch for live include recomputation when the relation store
   * does not expose `tableName` or when the watch source differs from the alias.
   */
  watch?: string | string[]
}

/**
 * Options for `app.flow()`.
 */
export interface FlowOptions {
  /**
   * Restrict which operations are registered.
   * Default: all operations enabled.
   *
   * @example `only: ['list', 'create', 'live']` — read-only + create + reactive
   */
  only?: Array<'list' | 'get' | 'create' | 'update' | 'delete' | 'live'>
  /**
   * Table name to watch for reactive pushes.
   * Default: last non-parameter path segment (e.g. `'/items'` → `'items'`,
   * `'/rooms/:roomId/messages'` → `'messages'`).
   */
  watch?: string
  /** Per-flow guards, applied after global middleware. */
  guards?: Middleware[]
  /**
   * Reactive push strategy for the `/live` endpoint.
   *
   * - `'snapshot'` (default) — re-fetches the full list via `store.list()` on every
   *   change and pushes the complete array. Simple and always consistent.
   *
   * - `'delta'` — pushes only the changed row without a DB round-trip:
   *   `{ operation: 'INSERT'|'UPDATE'|'DELETE', row: newRow ?? oldRow, timestamp }`.
   *   Ideal for chat / messaging where clients maintain local state and only
   *   need incremental updates.  Latency is dramatically lower under load.
   *
   * - `'smart'` — uses delta when the live response is simple enough to derive
   *   directly from the ChangeEvent, otherwise falls back to snapshot mode.
   *   This is the safest way to get low latency without manually deciding route
   *   by route.
   *
   * @example
   * ```ts
   * // Chat messages — push only the new message, not the full history
   * app.flow('/messages', messages, { push: 'delta' })
   *
   * // Prefer automatic planning first
   * app.flow('/messages', messages, { push: 'smart' })
   * ```
   */
  push?: 'snapshot' | 'delta' | 'smart'

  /**
   * Derive a `WHERE` clause from the request context (path params + query string).
   * Applied to **all** generated routes and reactive subscriptions automatically.
   *
   * Use this to scope a flow to a parent resource, e.g. room-scoped chat messages
   * on `/rooms/:roomId/messages`.
   *
   * @example
   * ```ts
   * // Only serve/push messages belonging to the current room
   * app.flow('/rooms/:roomId/messages', messages, {
   *   push: 'delta',
   *   queryFilter: (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
   * })
   * // GET /rooms/42/messages  → store.list({ where: { roomId: 42 } })
   * // POST /rooms/42/messages → merges roomId:42 into the body automatically
   * // WS subscribe /rooms/42/messages/live → only pushes messages where roomId === 42
   * ```
   */
  queryFilter?: (ctx: Context) => Record<string, unknown>

  /**
   * Additional fields merged into the request body when creating a record.
   * Defaults to the result of `queryFilter(ctx)` when `queryFilter` is set,
   * so path params are automatically stamped onto created rows.
   *
   * Override only when the create body needs different fields than the filter.
   *
   * @example
   * ```ts
   * app.flow('/rooms/:roomId/messages', messages, {
   *   queryFilter:  (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
   *   // createMerge defaults to queryFilter — no need to repeat
   * })
   * ```
   */
  createMerge?: (ctx: Context) => Record<string, unknown>

  /**
   * Maximum number of rows sent in the **initial reactive push** when a client
   * first subscribes to the `/live` endpoint.
   *
   * Without this, subscribing to `/messages/live` on a table with 500 k rows
   * would serialize and send the entire dataset over the WebSocket.
   *
   * For chat / feeds: set a small value (e.g. `50`) and let the client load
   * older history via the paginated REST endpoint.
   *
   * @example
   * ```ts
   * app.flow('/messages', messages, {
   *   push:         'delta',
   *   initialLimit: 50,   // send only the 50 most recent messages on connect
   * })
   * ```
   */
  initialLimit?: number

  /**
   * Automatically map URL query-string parameters to `store.list()` options.
   *
   * When set to `'auto'`, the following query params are recognised:
   * - `?limit=N`      → `{ limit: N }`   (max rows, default server max)
   * - `?offset=N`     → `{ offset: N }`  (skip N rows — page-based pagination)
   * - `?after=N`      → `{ after: N }`   (cursor: return rows with id > N)
   * - `?orderBy=col`  → `{ orderBy: col }`
   * - `?order=asc|desc` → `{ order: 'asc'|'desc' }`
   *
   * All other query params are ignored (use `queryFilter` for column filtering).
   *
   * @default false
   *
   * @example
   * ```ts
   * // Paginated messages: GET /messages?after=100&limit=20&order=asc
   * app.flow('/messages', messages, { query: 'auto', push: 'delta' })
   * ```
   */
  query?: 'auto' | false

  /**
   * Optional explicit query keys to include in the reactive subscription group key.
   * Use when automatic inference is insufficient.
   */
  liveQueryKeys?: string[]

  /**
   * Filter applied to each reactive push subscriber.
   * Receives the ChangeEvent and the subscriber's Context.
   * Return `true` to push, `false` to skip.
   *
   * When `queryFilter` is set, a default filter is derived automatically
   * (events whose changed row matches the filter are pushed; others are skipped).
   * Set `filter` explicitly to override this behaviour.
   *
   * @example
   * ```ts
   * // Only push to subscribers whose room matches the changed message
   * app.flow('/rooms/:roomId/messages', messages, {
   *   queryFilter: (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
   *   // filter is derived automatically from queryFilter — not needed here
   * })
   * ```
   */
  filter?: (event: ChangeEvent, ctx: Context) => boolean

  /**
   * Per-field validation functions. Called on POST / PUT / PATCH body fields.
   * Return `true` (or `false` + no message) to pass; return a non-empty string
   * to fail with that message in a 400 response.
   *
   * @example
   * ```ts
   * validate: {
   *   username: v => (v as string)?.length >= 3 || '이름은 3자 이상이어야 합니다',
   *   email:    v => String(v).includes('@') || '이메일 형식이 올바르지 않습니다',
   * }
   * ```
   */
  validate?: Record<string, (value: unknown, body: Record<string, unknown>) => boolean | string>

  /**
   * Lifecycle hooks — transform or inspect data at each CRUD stage.
   *
   * @example
   * ```ts
   * hooks: {
   *   beforeCreate: (data, ctx) => ({ ...data, userId: ctx.headers['x-user-id'] }),
   * }
   * ```
   */
  hooks?: FlowHooks

  /**
   * Field names to strip from **all** API responses (list, get, create, update).
   * Useful for hiding sensitive columns such as passwords or internal tokens.
   *
   * @example
   * ```ts
   * protect: ['password', 'secretToken']
   * ```
   */
  protect?: string[]

  /**
   * Join relations included when the client passes `?include=<name>`.
   * Uses N+1 simple look-up (suitable for low-cardinality joins).
   *
   * @example
   * ```ts
   * relations: {
   *   user: { store: users, foreignKey: 'userId' },
   * }
   * // GET /messages?include=user  →  each message gets a `user` field attached
   * ```
   */
  relations?: Record<string, FlowRelation>

  /**
   * Recompute live responses when included relations change.
   * One-hop includes only in v1.
   */
  liveInclude?: boolean
}

/**
 * Options for `app.openapi()`.
 */
export interface OpenAPIOptions {
  /** API title shown in generated docs. Default: `'RouteFlow API'`. */
  title?: string
  /** API version. Default: `'1.0.0'`. */
  version?: string
  /**
   * Path to serve a Swagger UI docs page.
   * Set to `false` to disable the UI (JSON spec is always served).
   * Default: `'/_docs'`.
   */
  docsPath?: string | false
}

/**
 * Options passed to createApp.
 */
export interface AppOptions {
  /**
   * Database adapter instance.
   * Optional when using `postgres()` / `sqlite()` factory functions with `.flow()` —
   * the adapter is auto-discovered from the stores passed to `.flow()`.
   */
  adapter?: DatabaseAdapter
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

  /**
   * Called when a WebSocket client connects.
   * Use this to maintain a presence table or track online users.
   *
   * @param clientId - Framework-assigned UUID for this connection
   * @param req      - Underlying Node.js HTTP upgrade request (contains headers, ip, etc.)
   *
   * @example
   * ```ts
   * const app = createApp({
   *   adapter: db, port: 3000,
   *   onConnect: (clientId, req) => {
   *     const userId = req.headers['x-user-id'] as string
   *     if (userId) presence.update(userId, { online: true, clientId })
   *   },
   *   onDisconnect: (clientId) => {
   *     presence.updateByClientId(clientId, { online: false })
   *   },
   * })
   * ```
   */
  onConnect?: (clientId: string, req: import('node:http').IncomingMessage) => void
  /**
   * Called when a WebSocket client disconnects (or errors out).
   * Use this to mark users as offline in a presence table.
   */
  onDisconnect?: (clientId: string) => void

  /**
   * URL prefix prepended to **every** route registered via `.flow()` and `.register()`.
   *
   * Critical for App Store deployments: once a native app ships with `/items` baked
   * into the bundle you cannot change it without a forced update.  Use `/v1` from day
   * one so future breaking changes can move to `/v2` without breaking existing installs.
   *
   * @example
   * ```ts
   * createApp({ prefix: '/v1', port: 3000 })
   *   .flow('/items', items)
   * // → GET /v1/items, POST /v1/items, GET /v1/items/:id, GET /v1/items/live
   * ```
   */
  prefix?: string

  /**
   * Enable gzip compression for HTTP JSON responses.
   *
   * Reduces payload size 5–10× on mobile metered connections.
   * Applied only when the client sends `Accept-Encoding: gzip` **and** the
   * response body is larger than 1 KB.  SSE streams are never compressed.
   *
   * Defaults to `false`. Enable in production with `compress: true`.
   */
  compress?: boolean
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
  /**
   * Optional fast-path that derives a delta payload directly from the ChangeEvent
   * without a DB round-trip.  When set, the engine calls this instead of `handler`.
   */
  deltaFn?: (event: ChangeEvent) => unknown
  /**
   * Restrict delta mode to specific watch tables. When omitted, any watched
   * table can use deltaFn.
   */
  deltaWatch?: string[]
  /**
   * Handler used **only** for the initial push when a client subscribes.
   * Falls back to `handler` when absent.
   *
   * Use this to limit the initial dataset size: return the most recent N rows
   * instead of the full table, while the regular handler returns the full list
   * for snapshot pushes triggered by DB changes.
   */
  initialHandler?: (ctx: Context) => Promise<unknown>
  /**
   * Optional grouping signature for query-aware live subscriptions.
   * Equivalent signatures share one fan-out group.
   */
  groupKeyFn?: (ctx: Context) => string | undefined
}

/** Push function signature used by the engine to deliver updates to a client. */
export type PushFn = (path: string, data: unknown) => void
