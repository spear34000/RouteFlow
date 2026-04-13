import 'reflect-metadata'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import type { AppOptions, Context, FlowOptions, Middleware, OpenAPIOptions, ReactiveEndpoint, TableStore } from './core/types.js'
import { routeFnStore } from './core/decorator/route.js'
import { reactiveFnStore } from './core/decorator/reactive.js'
import { guardFnStore, GUARD_METADATA } from './core/decorator/guard.js'
import type { RouteMetadata, ReactiveOptions } from './core/types.js'
import { ReactiveEngine } from './core/reactive/engine.js'
import { WebSocketTransport } from './core/transport/websocket-transport.js'
import { SseTransport } from './core/transport/sse-transport.js'
import { ReactiveApiError, notFound } from './core/errors.js'
import { body } from './core/body.js'
import { ROUTE_METADATA } from './core/decorator/route.js'
import { REACTIVE_METADATA } from './core/decorator/reactive.js'

// ── Public API ──────────────────────────────────────────────────────────────

export { Route, Get, Post, Put, Patch, Delete } from './core/decorator/route.js'
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
  private readonly options: Required<AppOptions>
  /** Collected route patterns for reactive endpoints */
  private readonly reactivePatterns: string[] = []
  /** All registered routes (for .routeflow/info.json) */
  private readonly registeredRoutes: Array<{ method: string; path: string; reactive: boolean }> = []
  /** Global middleware stack — runs before every route handler */
  private readonly middlewares: Middleware[] = []

  constructor(options: AppOptions) {
    this.options = {
      transport: 'websocket',
      port: 3000,
      cors: true,
      bodyLimit: 1_048_576, // 1 MiB
      logger: false,
      ...options,
    }

    this.fastify = Fastify({
      logger: this.options.logger,
      bodyLimit: this.options.bodyLimit,
    })

    this.engine = new ReactiveEngine(this.options.adapter)

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
      const fastifyHandler = async (req: { params: unknown; query: unknown; body: unknown; headers: unknown }, reply: { send: (v: unknown) => unknown }) => {
        const ctx: Context = {
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string>,
          body: req.body,
          headers: req.headers as Record<string, string>,
        }
        try {
          await runChain([...this.middlewares, ...routeGuards], ctx)
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

      // Register HTTP route with Fastify
      this.fastify.route({
        method: routeMeta.method,
        url: routeMeta.path,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: fastifyHandler as any,
      })

      this.registeredRoutes.push({ method: routeMeta.method, path: routeMeta.path, reactive: !!reactiveMeta })

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
        const isAlreadyLive = routeMeta.path.endsWith('/live')
        const livePath = isAlreadyLive ? routeMeta.path : `${routeMeta.path}/live`

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
    const tableName = options.watch
      ?? basePath.replace(/^\//, '').split('/')[0]
      ?? 'unknown'
    const livePath  = `${basePath}/live`
    const guards    = options.guards ?? []
    const only      = new Set(
      options.only ?? ['list', 'get', 'create', 'update', 'delete', 'live'],
    )

    // Shared handler wrapper: runs middleware chain then the given operation.
    const exec = (
      op: (ctx: Context) => Promise<unknown>,
    ) => async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx: Context = {
        params:  req.params  as Record<string, string>,
        query:   req.query   as Record<string, string>,
        body:    req.body,
        headers: req.headers as Record<string, string>,
      }
      try {
        await runChain([...this.middlewares, ...guards], ctx)
        return reply.send(await op(ctx))
      } catch (err) {
        if (err instanceof ReactiveApiError) throw err
        const msg = isProd
          ? 'Internal server error'
          : err instanceof Error ? err.message : String(err)
        throw new ReactiveApiError('HANDLER_ERROR', msg)
      }
    }

    if (only.has('list')) {
      this.fastify.get(basePath, exec(() => store.list()))
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
      this.fastify.post(basePath, exec((ctx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store.create(body(ctx) as any),
      ))
      this.registeredRoutes.push({ method: 'POST', path: basePath, reactive: false })
    }

    if (only.has('update')) {
      this.fastify.put(`${basePath}/:id`, exec(async (ctx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updated = await store.update(Number(ctx.params['id']), body(ctx) as any)
        if (!updated) throw notFound(`${ctx.params['id']} not found`)
        return updated
      }))
      this.registeredRoutes.push({ method: 'PUT', path: `${basePath}/:id`, reactive: false })
    }

    if (only.has('delete')) {
      this.fastify.delete(`${basePath}/:id`, exec(async (ctx) => ({
        ok: await store.delete(Number(ctx.params['id'])),
      })))
      this.registeredRoutes.push({ method: 'DELETE', path: `${basePath}/:id`, reactive: false })
    }

    if (only.has('live')) {
      this.engine.registerEndpoint({
        routePath: livePath,
        options:   { watch: tableName },
        handler:   () => store.list(),
      })
      this.reactivePatterns.push(livePath)
      this.fastify.get(livePath, exec(() => store.list()))
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

    await this.options.adapter.connect()

    if (this.options.transport === 'websocket') {
      this.transport = new WebSocketTransport(this.engine, this.reactivePatterns, this.options.cors)
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
            adapter: this.options.adapter.constructor.name,
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
    await this.options.adapter.disconnect()
  }
}

// ── Middleware chain runner ─────────────────────────────────────────────────

async function runChain(middlewares: Middleware[], ctx: Context): Promise<void> {
  let i = 0
  const next = async (): Promise<void> => {
    if (i >= middlewares.length) return
    await middlewares[i++](ctx, next)
  }
  await next()
}

// ── Swagger UI HTML builder ─────────────────────────────────────────────────

function buildSwaggerUI(specUrl: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
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
      url: '${specUrl}',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
    })
  </script>
</body>
</html>`
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
