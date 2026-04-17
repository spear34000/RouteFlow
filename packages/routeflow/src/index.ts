import 'reflect-metadata'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { gzip as zlibGzip } from 'node:zlib'
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import type { AppOptions, Context, FlowOptions, Middleware, OpenAPIOptions, ReactiveEndpoint, TableStore, DatabaseAdapter } from './core/types.js'
import { ADAPTER_SYMBOL } from './core/types.js'
import { routeFnStore } from './core/decorator/route.js'
import { reactiveFnStore } from './core/decorator/reactive.js'
import { guardFnStore, GUARD_METADATA } from './core/decorator/guard.js'
import type { RouteMetadata, ReactiveOptions } from './core/types.js'
import { ReactiveEngine, stableSerialize } from './core/reactive/engine.js'
import { WebSocketTransport } from './core/transport/websocket-transport.js'
import { SseTransport } from './core/transport/sse-transport.js'
import { ReactiveApiError, badRequest, notFound } from './core/errors.js'
import { body } from './core/body.js'
import { ROUTE_METADATA } from './core/decorator/route.js'
import { REACTIVE_METADATA } from './core/decorator/reactive.js'
import { RouteStore } from './core/adapter/route-store.js'
import { PostgresStore } from './adapters/postgres/postgres-store.js'
import type { PostgresStoreOptions } from './adapters/postgres/postgres-store.js'

// ── Public API ──────────────────────────────────────────────────────────────

export { Route, Get, Post, Put, Patch, Delete } from './core/decorator/route.js'
// Factory functions
export { ADAPTER_SYMBOL } from './core/types.js'
export type { FlowHooks, FlowRelation } from './core/types.js'
export { Reactive } from './core/decorator/reactive.js'
export { Guard } from './core/decorator/guard.js'
export { ReactiveApiError, badRequest, unauthorized, forbidden, notFound } from './core/errors.js'
export { body } from './core/body.js'
export { rateLimit } from './middleware/rate-limit.js'
export type { RateLimitOptions } from './middleware/rate-limit.js'
export {
  SUPPORTED_DATABASES,
  getDatabaseSupport,
  listOfficialDatabases,
  listSupportedDatabases,
} from './core/database-support.js'
export type {
  Context,
  ChangeEvent,
  DatabaseAdapter,
  TableStore,
  Middleware,
  ReactiveOptions,
  AppOptions,
  FlowOptions,
  OpenAPIOptions,
  HttpMethod,
  CorsOrigin,
} from './core/types.js'
export type {
  DatabaseCategory,
  DatabaseKey,
  DatabaseSupportDescriptor,
  DatabaseSupportMode,
  DatabaseSupportTier,
} from './core/database-support.js'

// Adapters (built-in)
export { MemoryAdapter, PollingAdapter } from './core/adapter/index.js'
export type {
  PollingAdapterOptions,
  PollingReadContext,
  PollingReadResult,
} from './core/adapter/index.js'

// ── ReactiveApp ─────────────────────────────────────────────────────────────

type AnyTransport = WebSocketTransport | SseTransport

const isProd = process.env['NODE_ENV'] === 'production'

/**
 * Main application class. Use `createApp()` to instantiate.
 */
export class ReactiveApp {
  private readonly fastify: FastifyInstance
  private readonly engine: ReactiveEngine
  private transport: AnyTransport | null = null
  private readonly options: Required<Omit<AppOptions, 'adapter' | 'onConnect' | 'onDisconnect' | 'prefix' | 'compress'>> & Pick<AppOptions, 'adapter' | 'onConnect' | 'onDisconnect' | 'prefix' | 'compress'>
  /** Normalised route prefix — leading slash, no trailing slash. Empty string when not set. */
  private get prefix(): string {
    const p = this.options.prefix ?? ''
    return p === '' ? '' : `/${p.replace(/^\/+|\/+$/g, '')}`
  }
  /** Collected route patterns for reactive endpoints */
  private readonly reactivePatterns: string[] = []
  /** All registered routes (for .routeflow/info.json) */
  private readonly registeredRoutes: Array<{ method: string; path: string; reactive: boolean }> = []
  /** Global middleware stack — runs before every route handler */
  private readonly middlewares: Middleware[] = []
  /** Adapters auto-discovered from stores passed to flow() */
  private readonly discoveredAdapters = new Set<DatabaseAdapter>()

  constructor(options: AppOptions) {
    this.options = {
      transport: 'websocket',
      port: 3000,
      cors: true,
      bodyLimit: 4_194_304, // 4 MiB — accommodate mobile photo uploads (was 1 MiB)
      logger: false,
      prefix: '',
      compress: false,
      ...options,
    }

    this.fastify = Fastify({
      logger: this.options.logger,
      bodyLimit: this.options.bodyLimit,
    })

    this.engine = new ReactiveEngine(this.options.adapter ?? null)

    // ── CORS ────────────────────────────────────────────────────────────────
    if (this.options.cors !== false) {
      const origin = this.options.cors === true ? '*' : this.options.cors
      this.fastify.addHook('onSend', async (_req, reply) => {
        const requestOrigin = _req.headers['origin']
        if (!requestOrigin) return

        if (origin === '*') {
          void reply.header('Access-Control-Allow-Origin', '*')
        } else if (Array.isArray(origin)) {
          if (origin.includes(requestOrigin)) {
            void reply.header('Access-Control-Allow-Origin', requestOrigin)
            void reply.header('Vary', 'Origin')
          }
        } else if (origin === requestOrigin) {
          void reply.header('Access-Control-Allow-Origin', requestOrigin)
          void reply.header('Vary', 'Origin')
        }
        void reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        void reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      })

      // Handle preflight
      this.fastify.options('*', async (_req, reply) => {
        const requestOrigin = _req.headers['origin']
        if (requestOrigin) {
          if (origin === '*') {
            void reply.header('Access-Control-Allow-Origin', '*')
          } else if (Array.isArray(origin) && origin.includes(requestOrigin)) {
            void reply.header('Access-Control-Allow-Origin', requestOrigin)
          } else if (origin === requestOrigin) {
            void reply.header('Access-Control-Allow-Origin', requestOrigin)
          }
        }
        void reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        void reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        void reply.header('Access-Control-Max-Age', '86400')
        return reply.status(204).send()
      })
    }

    // ── Health check ─────────────────────────────────────────────────────────
    // Auto-registered at GET /_health so Kubernetes, Consul, and load balancers
    // can probe liveness without any application-level configuration.
    this.fastify.get('/_health', async (_req, reply) =>
      reply.send({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      }),
    )

    // ── Gzip compression ─────────────────────────────────────────────────────
    // Applied when compress:true AND the client sends Accept-Encoding: gzip AND
    // the response body is > 1 KB.  SSE streams bypass this via reply.raw and
    // are never passed through onSend, so no explicit skip is needed.
    if (this.options.compress) {
      this.fastify.addHook('onSend', async (req, reply, payload) => {
        if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload
        const acceptEncoding = (req.headers['accept-encoding'] ?? '') as string
        if (!acceptEncoding.includes('gzip')) return payload
        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
        if (buf.length < 1024) return payload
        reply.header('Content-Encoding', 'gzip')
        reply.removeHeader('Content-Length')
        return new Promise<Buffer>((resolve, reject) => {
          zlibGzip(buf, (err, compressed) => {
            if (err) reject(err)
            else resolve(compressed)
          })
        })
      })
    }

    // ── Error handler ────────────────────────────────────────────────────────
    this.fastify.setErrorHandler((error, _req, reply) => {
      if (error instanceof ReactiveApiError) {
        return reply.status(error.statusCode).send({
          error: error.code,
          message: error.message,
        })
      }
      // Never leak internal error details in production
      const message = isProd ? 'Internal server error' : (error.message ?? 'Unknown error')
      return reply.status(error.statusCode ?? 500).send({
        error: 'INTERNAL_ERROR',
        message,
      })
    })
  }

  // ── Middleware ─────────────────────────────────────────────────────────────

  /**
   * Add a global middleware that runs before every HTTP route handler.
   *
   * Middlewares run in registration order. Call `next()` to continue the chain.
   * Throw a `ReactiveApiError` (or its convenience factories) to abort.
   *
   * @example
   * ```ts
   * import { createApp, unauthorized } from 'routeflow-api'
   *
   * const app = createApp({ adapter, port: 3000 })
   *
   * // Auth middleware
   * app.use(async (ctx, next) => {
   *   if (!ctx.headers['authorization']) throw unauthorized()
   *   await next()
   * })
   *
   * // Logging middleware
   * app.use(async (ctx, next) => {
   *   const start = Date.now()
   *   await next()
   *   console.log(`${ctx.params} — ${Date.now() - start}ms`)
   * })
   * ```
   */
  use(middleware: Middleware): this {
    this.middlewares.push(middleware)
    return this
  }

  // ── Registration ───────────────────────────────────────────────────────────

  /**
   * Register a controller class **or instance**.
   *
   * Scans the controller's methods for `@Route`, `@Reactive`, and `@Guard` decorators
   * and registers HTTP routes and reactive endpoints accordingly.
   *
   * Passing a **pre-constructed instance** is the recommended pattern when the controller
   * needs injected dependencies (stores, services, etc.). Passing a **class constructor**
   * still works for dependency-free controllers.
   *
   * When `@Reactive` is added to a route that does **not** already end with `/live`,
   * a companion live endpoint is automatically registered at `{routePath}/live`.
   * This means you do not need a separate handler for the reactive path.
   *
   * @example
   * ```ts
   * // Recommended: pass an instance with dependencies
   * class ItemController {
   *   constructor(private items: TableStore<Item>) {}
   *
   *   @Route('GET', '/items')
   *   @Reactive({ watch: 'items' })      // auto-registers /items/live
   *   async getItems() { return this.items.list() }
   * }
   * app.register(new ItemController(items))
   *
   * // Also works: class constructor (no-arg controllers)
   * app.register(HealthController)
   * ```
   */
  register(controller: (new (...args: never[]) => object) | object): this {
    // Fail early with a clear message if reflect-metadata was not imported.
    if (typeof Reflect === 'undefined' || typeof Reflect.getMetadata !== 'function') {
      throw new Error(
        '[RouteFlow] reflect-metadata is not available. ' +
          "Add `import 'reflect-metadata'` at the very top of your entry file.",
      )
    }

    // Accept either a class constructor or a pre-constructed instance.
    const instance =
      typeof controller === 'function'
        ? new (controller as new () => object)()
        : controller

    const controllerName =
      (instance as Record<string, unknown>).constructor instanceof Function
        ? ((instance as Record<string, unknown>).constructor as { name?: string }).name ?? 'Controller'
        : 'Controller'

    const proto = Object.getPrototypeOf(instance) as object

    const methodNames = Object.getOwnPropertyNames(proto).filter(
      (name) =>
        name !== 'constructor' &&
        typeof (proto as Record<string, unknown>)[name] === 'function',
    )

    for (const methodName of methodNames) {
      const fn = (proto as Record<string, unknown>)[methodName] as object
      const routeMeta: RouteMetadata | undefined =
        routeFnStore.get(fn) ??
        (Reflect.getMetadata(ROUTE_METADATA, proto, methodName) as RouteMetadata | undefined)

      const reactiveMeta: ReactiveOptions | undefined =
        reactiveFnStore.get(fn) ??
        (Reflect.getMetadata(REACTIVE_METADATA, proto, methodName) as ReactiveOptions | undefined)

      // Warn if @Reactive is present but @Route is missing — silent failure otherwise.
      if (!routeMeta && reactiveMeta) {
        console.warn(
          `[RouteFlow] ${controllerName}.${methodName} has @Reactive but no @Route — ` +
            'the reactive endpoint will not be registered. Add @Route to fix this.',
        )
        continue
      }

      if (!routeMeta) continue

      // Per-route guards (from @Guard decorator)
      const routeGuards: Middleware[] =
        guardFnStore.get(fn) ??
        (Reflect.getMetadata(GUARD_METADATA, proto, methodName) as Middleware[] | undefined) ??
        []

      const handler = (instance as Record<string, unknown>)[methodName] as (
        ctx: Context,
      ) => Promise<unknown>

      // Shared Fastify route handler — reused for the main route and the auto-live companion.
      const fastifyHandler = async (req: { params: unknown; query: unknown; body: unknown; headers: Record<string, unknown>; id?: unknown }, reply: { send: (v: unknown) => unknown; header: (k: string, v: string) => void }) => {
        const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID()
        reply.header('X-Request-ID', requestId)
        const ctx: Context = {
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string>,
          body: req.body,
          headers: req.headers as Record<string, string>,
          requestId,
        }
        try {
          await runChain(routeGuards.length ? [...this.middlewares, ...routeGuards] : this.middlewares, ctx)
          const result = await handler.call(instance, ctx)
          return reply.send(result)
        } catch (err) {
          if (err instanceof ReactiveApiError) throw err
          const msg = isProd
            ? 'Internal server error'
            : err instanceof Error
              ? err.message
              : String(err)
          throw new ReactiveApiError('HANDLER_ERROR', msg)
        }
      }

      // Apply the global route prefix (e.g. '/v1') to all registered paths.
      const prefixedPath = `${this.prefix}${routeMeta.path}`

      // Register HTTP route with Fastify
      this.fastify.route({
        method: routeMeta.method,
        url: prefixedPath,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: fastifyHandler as any,
      })

      this.registeredRoutes.push({ method: routeMeta.method, path: prefixedPath, reactive: !!reactiveMeta })

      // Register reactive endpoint if @Reactive is present.
      //
      // Auto-live: if the route path does NOT already end with '/live', a companion
      // GET endpoint is created at `{routePath}/live` so developers do not need to
      // write a separate live handler with identical logic.
      //
      //   @Route('GET', '/items') + @Reactive({ watch: 'items' })
      //   → REST  at GET /items
      //   → Live  at GET /items/live  (auto-registered, same handler)
      //   → WS/SSE subscribers connect to /items/live
      if (reactiveMeta) {
        const isAlreadyLive = prefixedPath.endsWith('/live')
        const livePath = isAlreadyLive ? prefixedPath : `${prefixedPath}/live`

        const endpoint: ReactiveEndpoint = {
          routePath: livePath,
          options: reactiveMeta,
          handler: (ctx: Context) => handler.call(instance, ctx),
        }
        this.engine.registerEndpoint(endpoint)
        this.reactivePatterns.push(livePath)

        // Register the companion HTTP GET {path}/live route when auto-live is triggered.
        if (!isAlreadyLive) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.fastify.route({ method: 'GET', url: livePath, handler: fastifyHandler as any })
          this.registeredRoutes.push({ method: 'GET', path: livePath, reactive: true })
        }
      }
    }

    return this
  }

  // ── Flow API ───────────────────────────────────────────────────────────────

  /**
   * Register a complete reactive CRUD endpoint for a table in one line.
   * Data changes in the store automatically **flow** to connected WebSocket/SSE clients.
   *
   * Creates:
   * ```
   * GET    /path          → store.list()
   * GET    /path/:id      → store.get(id)           throws 404 if not found
   * POST   /path          → store.create(body)
   * PUT    /path/:id      → store.update(id, body)  throws 404 if not found
   * DELETE /path/:id      → store.delete(id)        → { ok: boolean }
   * GET    /path/live     → reactive push on every table change (WS/SSE)
   * ```
   *
   * Global middleware and `guards` option apply to every generated route.
   *
   * @example — minimal (full CRUD + reactive in one line)
   * ```ts
   * const db    = new RouteStore('./data/app.db')
   * const items = db.table('items', { name: 'text', createdAt: 'text' })
   *
   * createApp({ adapter: db, port: 3000 })
   *   .flow('/items', items)
   *   .listen()
   * ```
   *
   * @example — read-only + reactive only
   * ```ts
   * app.flow('/products', products, { only: ['list', 'get', 'live'] })
   * ```
   *
   * @example — with per-flow auth guard
   * ```ts
   * app.flow('/orders', orders, { guards: [requireAuth] })
   * ```
   */
  flow<T extends { id: number }>(
    basePath: string,
    store: TableStore<T>,
    options: FlowOptions = {},
  ): this {
    // Derive the table name from the original (unprefixed) base path so that
    // the watch key matches the adapter's table name regardless of prefix.
    const tableName     = options.watch
      ?? basePath.replace(/^\//, '').split('/').filter(s => !s.startsWith(':')).at(-1)
      ?? 'unknown'
    // Apply the global prefix to all routes registered by this flow.
    basePath            = `${this.prefix}${basePath}`
    const livePath      = `${basePath}/live`
    const guards        = options.guards        ?? []
    const pushMode      = options.push          ?? 'snapshot'
    const queryFilter   = options.queryFilter
    const createMerge   = options.createMerge   ?? queryFilter
    const initialLimit  = options.initialLimit
    const queryMode     = options.query         ?? false
    const liveQueryKeys = options.liveQueryKeys
    const flowFilter    = options.filter
    const validate      = options.validate
    const hooks         = options.hooks
    const protect       = options.protect
    const relations     = options.relations
    const liveInclude   = options.liveInclude   ?? false
    const only          = new Set(
      options.only ?? ['list', 'get', 'create', 'update', 'delete', 'live'],
    )

    // ── Auto-discover adapter from store ──────────────────────────────────────
    const storeAdapter = (store as unknown as Record<symbol, unknown>)[ADAPTER_SYMBOL] as DatabaseAdapter | undefined
    if (storeAdapter) {
      this.discoveredAdapters.add(storeAdapter)
      this.engine.registerAdapter(storeAdapter)
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Build store.list() options from the request context.
     * - queryFilter derives the WHERE clause from path params
     * - query:'auto' maps ?limit / ?offset / ?after / ?orderBy / ?order from query string
     */
    const buildListOpts = (ctx: Context) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: Record<string, any> = {}
      if (queryFilter) opts['where'] = queryFilter(ctx)
      if (queryMode === 'auto') {
        const q = ctx.query
        if (q['limit']   != null) opts['limit']   = Math.min(Number(q['limit']),  10_000)
        if (q['offset']  != null) opts['offset']  = Number(q['offset'])
        if (q['after']   != null) opts['after']   = Number(q['after'])
        if (q['orderBy'] != null) opts['orderBy'] = q['orderBy']
        if (q['order']   != null) opts['order']   = q['order']
      }
      return opts
    }

    const buildLiveGroupSignature = (ctx: Context): string | undefined => {
      const parts: Record<string, unknown> = {}
      const queryKeys = new Set<string>(liveQueryKeys ?? [])

      if (queryFilter) parts['where'] = queryFilter(ctx)
      if (queryMode === 'auto') {
        for (const key of ['limit', 'offset', 'after', 'orderBy', 'order']) {
          if (ctx.query[key] != null) queryKeys.add(key)
        }
      }
      if (relations && ctx.query['include'] != null) queryKeys.add('include')

      if (queryKeys.size > 0) {
        const queryPart: Record<string, string> = {}
        for (const key of [...queryKeys].sort()) {
          const value = ctx.query[key]
          if (value != null) queryPart[key] = value
        }
        if (Object.keys(queryPart).length > 0) parts['query'] = queryPart
      }

      return Object.keys(parts).length > 0 ? stableSerialize(parts) : undefined
    }

    const resolveRelationWatch = (name: string, relation: NonNullable<typeof relations>[string]): string[] => {
      if (relation.watch) return Array.isArray(relation.watch) ? relation.watch : [relation.watch]
      const explicit = (relation.store as TableStore<{ id: number }> & { tableName?: string }).tableName
      if (explicit) return [explicit]
      return name.endsWith('s') ? [name] : [name, `${name}s`]
    }

    /** Strip protected fields from any response object or array. */
    const applyProtect = (data: unknown): unknown => {
      if (!protect?.length) return data
      if (Array.isArray(data)) return data.map(applyProtect)
      if (data && typeof data === 'object') {
        const out = { ...data as Record<string, unknown> }
        for (const f of protect) delete out[f]
        return out
      }
      return data
    }

    /** Resolve ?include=<name> relations on a row or array of rows.
     *
     * For lists: batches FK values per relation (dedup → parallel fetch → in-memory join)
     * so N rows × K relations = K parallel queries instead of N×K sequential queries.
     */
    const applyRelations = async (data: unknown, ctx: Context): Promise<unknown> => {
      if (!relations) return data
      const includes = (ctx.query['include'] as string | undefined)?.split(',').map(s => s.trim()).filter(Boolean) ?? []
      if (!includes.length) return data

      // ── List: batch-load each relation ────────────────────────────────────
      if (Array.isArray(data) && data.length > 0) {
        const rows = data as Record<string, unknown>[]

        // For each included relation, collect unique FK IDs, then fetch all in parallel.
        const relMaps = new Map<string, Map<number, unknown>>()
        await Promise.all(
          includes.map(async (name) => {
            const rel = relations[name]
            if (!rel) return
            // Deduplicate FK values across all rows
            const fkSet = new Set<number>()
            for (const row of rows) {
              const fk = row[rel.foreignKey]
              if (fk != null) fkSet.add(Number(fk))
            }
            if (!fkSet.size) return
            const fkArr = [...fkSet]
            // Prefer getMany() (single IN-clause query) when the store supports it;
            // fall back to parallel get() calls for custom stores that don't implement it.
            const fetched = rel.store.getMany
              ? await rel.store.getMany(fkArr)
              : await Promise.all(fkArr.map((id) => rel.store.get(id)))
            relMaps.set(name, new Map(fkArr.map((id, i) => [id, fetched[i]])))
          }),
        )

        return rows.map((row) => {
          const out = { ...row }
          for (const name of includes) {
            const rel = relations[name]
            if (!rel) continue
            const relMap = relMaps.get(name)
            const fkVal = row[rel.foreignKey]
            if (relMap && fkVal != null) out[name] = relMap.get(Number(fkVal)) ?? null
          }
          return out
        })
      }

      // ── Single row: parallel-fetch all includes ───────────────────────────
      if (data && typeof data === 'object') {
        const row = data as Record<string, unknown>
        const out = { ...row }
        await Promise.all(
          includes.map(async (name) => {
            const rel = relations[name]
            if (!rel) return
            const fkVal = row[rel.foreignKey]
            if (fkVal != null) out[name] = await rel.store.get(Number(fkVal))
          }),
        )
        return out
      }

      return data
    }

    /** Run field-level validation on write body. Throws 400 on failure. */
    const runValidate = (bodyData: Record<string, unknown>): void => {
      if (!validate) return
      const errors: string[] = []
      for (const [field, fn] of Object.entries(validate)) {
        const result = fn(bodyData[field], bodyData)
        if (result !== true && result !== false) errors.push(String(result))
        else if (result === false) errors.push(`${field} is invalid`)
      }
      if (errors.length) throw badRequest(errors.join('; '))
    }

    // Shared handler wrapper: runs middleware chain then the given operation.
    const exec = (
      op: (ctx: Context) => Promise<unknown>,
    ) => async (req: FastifyRequest, reply: FastifyReply) => {
      // Use the X-Request-ID header when present (forwarded by API gateway / load
      // balancer) so the ID spans the full request chain; otherwise generate one.
      const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID()
      reply.header('X-Request-ID', requestId)
      const ctx: Context = {
        params:    req.params  as Record<string, string>,
        query:     req.query   as Record<string, string>,
        body:      req.body,
        headers:   req.headers as Record<string, string>,
        requestId,
      }
      try {
        await runChain(guards.length ? [...this.middlewares, ...guards] : this.middlewares, ctx)
        let result = await op(ctx)
        result = await applyRelations(result, ctx)
        result = applyProtect(result)
        return reply.send(result)
      } catch (err) {
        if (err instanceof ReactiveApiError) throw err
        const msg = isProd
          ? 'Internal server error'
          : err instanceof Error ? err.message : String(err)
        throw new ReactiveApiError('HANDLER_ERROR', msg)
      }
    }

    // ── Routes ────────────────────────────────────────────────────────────────

    if (only.has('list')) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.fastify.get(basePath, exec((ctx) => store.list(buildListOpts(ctx) as any)))
      this.registeredRoutes.push({ method: 'GET', path: basePath, reactive: false })
    }

    if (only.has('get')) {
      this.fastify.get(`${basePath}/:id`, exec(async (ctx) => {
        const item = await store.get(Number(ctx.params['id']))
        if (!item) throw notFound(`${ctx.params['id']} not found`)
        return item
      }))
      this.registeredRoutes.push({ method: 'GET', path: `${basePath}/:id`, reactive: false })
    }

    if (only.has('create')) {
      this.fastify.post(basePath, exec(async (ctx) => {
        // Merge path params (from queryFilter / createMerge) into the body
        // so that e.g. POST /rooms/42/messages automatically stamps roomId:42.
        let merged = createMerge
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? { ...body(ctx), ...createMerge(ctx) } as any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          : body(ctx) as any

        runValidate(merged)

        if (hooks?.beforeCreate) merged = await hooks.beforeCreate(merged, ctx)
        const created = await store.create(merged)
        if (hooks?.afterCreate) await hooks.afterCreate(created, ctx)
        return created
      }))
      this.registeredRoutes.push({ method: 'POST', path: basePath, reactive: false })
    }

    if (only.has('update')) {
      // Both PUT (full replace) and PATCH (partial) are registered so clients can
      // use whichever HTTP verb fits their convention.
      const updateHandler = exec(async (ctx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let data = body(ctx) as any

        runValidate(data)

        if (hooks?.beforeUpdate) data = await hooks.beforeUpdate(data, ctx)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updated = await store.update(Number(ctx.params['id']), data as any)
        if (!updated) throw notFound(`${ctx.params['id']} not found`)
        if (hooks?.afterUpdate) await hooks.afterUpdate(updated, ctx)
        return updated
      })
      this.fastify.put  (`${basePath}/:id`, updateHandler)
      this.fastify.patch(`${basePath}/:id`, updateHandler)
      this.registeredRoutes.push({ method: 'PUT',   path: `${basePath}/:id`, reactive: false })
      this.registeredRoutes.push({ method: 'PATCH', path: `${basePath}/:id`, reactive: false })
    }

    if (only.has('delete')) {
      this.fastify.delete(`${basePath}/:id`, exec(async (ctx) => {
        const id = Number(ctx.params['id'])
        if (hooks?.beforeDelete) await hooks.beforeDelete(id, ctx)
        const ok = await store.delete(id)
        if (ok && hooks?.afterDelete) await hooks.afterDelete(id, ctx)
        return { ok }
      }))
      this.registeredRoutes.push({ method: 'DELETE', path: `${basePath}/:id`, reactive: false })
    }

    if (only.has('live')) {
      // ── Delta push mode ──────────────────────────────────────────────────────
      // When push: 'delta', the engine bypasses store.list() entirely and sends
      // only the changed row.  This eliminates the DB round-trip on every mutation,
      // which is critical for high-frequency updates (chat, live feeds, etc.).
      //
      // Delta payload shape:
      //   { operation: 'INSERT' | 'UPDATE' | 'DELETE', row: T | null, timestamp: number }
      const unsafeForDelta =
        queryFilter != null ||
        queryMode === 'auto' ||
        flowFilter != null ||
        (protect?.length ?? 0) > 0 ||
        relations != null ||
        liveInclude

      const shouldUseSmartDelta = pushMode === 'smart' && !unsafeForDelta
      const deltaFn = pushMode === 'delta' || shouldUseSmartDelta
        ? (event: import('./core/types.js').ChangeEvent) => ({
            operation: event.operation,
            row:       event.newRow ?? event.oldRow,
            timestamp: event.timestamp,
          })
        : undefined

      // ── Reactive filter ───────────────────────────────────────────────────
      // When queryFilter is provided, derive a reactive filter automatically:
      // only push to subscribers whose filter matches the changed row.
      // This ensures that /rooms/42/messages/live only receives messages
      // where roomId === 42, not messages from all rooms.
      const derivedFilter = flowFilter
        ?? (queryFilter
          ? (event: import('./core/types.js').ChangeEvent, ctx: Context) => {
              if (liveInclude && event.table !== tableName) return true
              const where = queryFilter(ctx)
              const row = (event.newRow ?? event.oldRow) as Record<string, unknown> | null
              if (!row) return true
              return Object.entries(where).every(([k, v]) => row[k] === v)
            }
          : undefined)

      // ── Snapshot handler (full list, respects queryFilter) ─────────────────
      const loadLiveRows = async (ctx: Context) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store.list(buildListOpts(ctx) as any)

      const snapshotHandler = async (ctx: Context) => {
        const listed = await loadLiveRows(ctx)
        return applyProtect(await applyRelations(listed, ctx))
      }

      // ── Initial push handler (limited snapshot for large tables) ───────────
      const initialHandler = initialLimit != null
        ? async (ctx: Context) => {
          const baseOpts = buildListOpts(ctx) as Record<string, unknown>
          const initialOpts = {
            ...baseOpts,
            limit: initialLimit,
            order: 'desc',
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const listed = await store.list(initialOpts as any)
          return applyProtect(await applyRelations(listed, ctx))
        }
        : undefined

      const watchTables = [...new Set([
        tableName,
        ...(liveInclude && relations
          ? Object.entries(relations).flatMap(([name, relation]) => resolveRelationWatch(name, relation))
          : []),
      ])]

      this.engine.registerEndpoint({
        routePath: livePath,
        options:   { watch: watchTables, filter: derivedFilter },
        handler:   snapshotHandler,
        deltaFn,
        deltaWatch: deltaFn ? [tableName] : undefined,
        initialHandler,
        groupKeyFn: buildLiveGroupSignature,
      })
      this.reactivePatterns.push(livePath)
      this.fastify.get(livePath, exec((ctx) => loadLiveRows(ctx)))
      this.registeredRoutes.push({ method: 'GET', path: livePath, reactive: true })
    }

    return this
  }

  // ── OpenAPI ─────────────────────────────────────────────────────────────────

  /**
   * Expose a machine-readable OpenAPI 3.0 spec at `GET /openapi.json`
   * and an optional Swagger UI at `GET /_docs`.
   *
   * Useful for generating typed Python clients (FastAPI/httpx) and other
   * language integrations from a single source of truth.
   *
   * @example
   * ```ts
   * createApp({ adapter: db, port: 3000 })
   *   .flow('/items', items)
   *   .openapi({ title: 'Items API' })
   *   .listen()
   * ```
   *
   * Then generate a typed Python client:
   * ```bash
   * pip install openapi-python-client
   * openapi-python-client generate --url http://localhost:3000/openapi.json
   * ```
   *
   * Or call from FastAPI (Python) with full type hints:
   * ```python
   * import httpx
   * # Generated client is fully typed from the schema
   * from items_api_client import Client
   * from items_api_client.api.default import get_items
   *
   * client = Client(base_url="http://localhost:3000")
   * items  = get_items.sync(client=client)
   * ```
   */
  openapi(options: OpenAPIOptions = {}): this {
    // Build the spec lazily on first request so routes registered *after*
    // openapi() (e.g. via subsequent flow()/register() calls) are included.
    let cachedSpec: Record<string, unknown> | null = null
    const getSpec = () => {
      if (!cachedSpec) cachedSpec = this.buildOpenAPISpec(options)
      return cachedSpec
    }
    // Invalidate cache whenever new routes are added after openapi() is called.
    const origPush = this.registeredRoutes.push.bind(this.registeredRoutes)
    this.registeredRoutes.push = (...args) => {
      cachedSpec = null
      return origPush(...args)
    }

    this.fastify.get('/openapi.json', async (_req, reply) =>
      reply.header('Content-Type', 'application/json').send(getSpec()),
    )

    const docsPath = options.docsPath !== false
      ? (typeof options.docsPath === 'string' ? options.docsPath : '/_docs')
      : null

    if (docsPath) {
      this.fastify.get(docsPath, async (_req, reply) =>
        reply.header('Content-Type', 'text/html').send(
          buildSwaggerUI('/openapi.json', options.title ?? 'RouteFlow API'),
        ),
      )
    }

    return this
  }

  private buildOpenAPISpec(options: OpenAPIOptions): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {}

    for (const route of this.registeredRoutes) {
      if (!paths[route.path]) paths[route.path] = {}
      const method = route.method.toLowerCase()

      // Build a human-readable operationId from method + path
      const opId = `${method}_${
        route.path
          .replace(/[/:]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '')
      }`

      const operation: Record<string, unknown> = {
        operationId: opId,
        tags: [route.path.split('/')[1] ?? 'default'],
        responses: { '200': { description: 'Success' } },
      }

      if (route.reactive) {
        operation['description'] =
          'Reactive endpoint — subscribe via WebSocket/SSE for live push updates.'
        operation['x-routeflow-reactive'] = true
      }

      // Expose request body schema for write methods
      if (method === 'post' || method === 'put' || method === 'patch') {
        operation['requestBody'] = {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        }
      }

      paths[route.path][method] = operation
    }

    return {
      openapi: '3.0.0',
      info: {
        title:   options.title   ?? 'RouteFlow API',
        version: options.version ?? '1.0.0',
      },
      paths,
    }
  }

  // ── Fastify escape hatch ───────────────────────────────────────────────────

  /**
   * Access the underlying Fastify instance for supplemental routes such as
   * health checks, static assets, or demo pages.
   *
   * @remarks This is an escape hatch — prefer `app.use()` and `@Guard()` for
   * cross-cutting concerns whenever possible.
   */
  getFastify(): FastifyInstance {
    return this.fastify
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the HTTP server.
   * Connects the database adapter before accepting connections.
   *
   * @param port - Override the port set in AppOptions
   */
  async listen(port?: number): Promise<void> {
    const listenPort = port ?? this.options.port

    // Connect all adapters (explicit one takes priority; otherwise auto-discovered).
    const adapters = this.options.adapter
      ? [this.options.adapter]
      : [...this.discoveredAdapters]
    await Promise.all(adapters.map((a) => a.connect()))

    if (this.options.transport === 'websocket') {
      this.transport = new WebSocketTransport(
        this.engine,
        this.reactivePatterns,
        this.options.cors,
        this.options.onConnect,
        this.options.onDisconnect,
      )
    } else if (this.options.transport === 'sse') {
      const sseTransport = new SseTransport(this.engine, this.reactivePatterns)
      sseTransport.register(this.fastify)
      this.transport = sseTransport
    }

    await this.fastify.ready()

    if (this.transport instanceof WebSocketTransport) {
      this.transport.attach(this.fastify.server)
    }

    await this.fastify.listen({ port: listenPort, host: '0.0.0.0' })
    console.log(
      `[RouteFlow] Listening on port ${listenPort} (transport: ${this.options.transport})`,
    )

    // ── Graceful shutdown ────────────────────────────────────────────────────
    // Register SIGTERM and SIGINT handlers so container orchestrators (Kubernetes,
    // Docker, Fly.io, …) can drain connections cleanly before killing the process.
    // Without this, in-flight requests are cut mid-response and DB connections
    // are leaked.  We give 10 s for in-flight work to complete, then force-exit.
    const shutdown = async (signal: string): Promise<void> => {
      console.log(`[RouteFlow] ${signal} received — gracefully shutting down…`)
      const timeout = setTimeout(() => {
        console.error('[RouteFlow] Graceful shutdown timed out — forcing exit.')
        process.exit(1)
      }, 10_000)
      timeout.unref()  // don't prevent the process from exiting on its own
      try {
        await this.close()
        clearTimeout(timeout)
        process.exit(0)
      } catch (err) {
        console.error('[RouteFlow] Shutdown error:', err instanceof Error ? err.message : String(err))
        clearTimeout(timeout)
        process.exit(1)
      }
    }

    // Register once — guard against duplicate listen() calls in tests.
    if (!process.listenerCount('SIGTERM')) process.once('SIGTERM', () => void shutdown('SIGTERM'))
    if (!process.listenerCount('SIGINT'))  process.once('SIGINT',  () => void shutdown('SIGINT'))

    this.writeInfo(listenPort)
  }

  private writeInfo(port: number): void {
    try {
      const dir = join(process.cwd(), '.routeflow')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'info.json'),
        JSON.stringify(
          {
            port,
            transport: this.options.transport,
            adapter: this.options.adapter?.constructor.name
              ?? [...this.discoveredAdapters].map(a => a.constructor.name).join(',')
              ?? 'unknown',
            routes: this.registeredRoutes,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      )
    } catch {
      // 저장 실패 시 서버 동작에 영향 없음
    }
  }

  /**
   * Gracefully shut down the server and disconnect from the database.
   */
  async close(): Promise<void> {
    this.engine.destroy()
    if (this.transport) await this.transport.close()
    await this.fastify.close()
    const adapters = this.options.adapter
      ? [this.options.adapter]
      : [...this.discoveredAdapters]
    await Promise.all(adapters.map((a) => a.disconnect()))
  }
}

// ── Middleware chain runner ─────────────────────────────────────────────────

async function runChain(middlewares: readonly Middleware[], ctx: Context): Promise<void> {
  let i = 0
  const next = async (): Promise<void> => {
    if (i >= middlewares.length) return
    await middlewares[i++](ctx, next)
  }
  await next()
}

// ── Swagger UI HTML builder ─────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildSwaggerUI(specUrl: string, title: string): string {
  const safeTitle   = escapeHtml(title)
  const safeSpecUrl = escapeHtml(specUrl)
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; }
    #swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '${safeSpecUrl}',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
    })
  </script>
</body>
</html>`
}

// ── DB factory functions ────────────────────────────────────────────────────

/**
 * Create a SQLite-backed store. Short-hand for `new RouteStore(path)`.
 *
 * @example
 * ```ts
 * import { sqlite, createApp } from 'routeflow-api'
 *
 * const db = sqlite('./data.db')
 * const tasks = db.table('tasks', { title: 'text', done: 'integer' })
 *
 * createApp({ port: 3000 }).flow('/tasks', tasks).listen()
 * ```
 */
export function sqlite(path: string): RouteStore {
  return new RouteStore(path)
}

/**
 * Create a PostgreSQL-backed store. Short-hand for `new PostgresStore({ connectionString })`.
 *
 * @example
 * ```ts
 * import { postgres, createApp } from 'routeflow-api'
 *
 * const pg = postgres(process.env.DATABASE_URL!)
 * const users = pg.table('users', { username: 'text', email: 'text' })
 *
 * createApp({ port: 3000 }).flow('/users', users).listen()
 * ```
 */
export function postgres(
  connectionString: string,
  options?: Omit<PostgresStoreOptions, 'connectionString'>,
): PostgresStore {
  return new PostgresStore({ connectionString, ...options })
}

// ── createApp factory ───────────────────────────────────────────────────────

/**
 * Create a new RouteFlow application.
 *
 * @example
 * ```ts
 * import { createApp, MemoryAdapter, unauthorized } from 'routeflow-api'
 *
 * const app = createApp({
 *   adapter: new MemoryAdapter(),
 *   port: 3000,
 *   cors: 'https://myapp.com',  // or true for all origins
 *   bodyLimit: 512_000,         // 500 KB
 * })
 *
 * // Global auth middleware
 * app.use(async (ctx, next) => {
 *   if (!ctx.headers['authorization']) throw unauthorized()
 *   await next()
 * })
 *
 * app.register(MyController)
 * await app.listen()
 * ```
 */
export function createApp(options: AppOptions): ReactiveApp {
  return new ReactiveApp(options)
}
