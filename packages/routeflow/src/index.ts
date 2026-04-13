import 'reflect-metadata'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { FastifyInstance } from 'fastify'
import type { AppOptions, Context, Middleware, ReactiveEndpoint } from './core/types.js'
import { routeFnStore } from './core/decorator/route.js'
import { reactiveFnStore } from './core/decorator/reactive.js'
import { guardFnStore, GUARD_METADATA } from './core/decorator/guard.js'
import type { RouteMetadata, ReactiveOptions } from './core/types.js'
import { ReactiveEngine } from './core/reactive/engine.js'
import { WebSocketTransport } from './core/transport/websocket-transport.js'
import { SseTransport } from './core/transport/sse-transport.js'
import { ReactiveApiError } from './core/errors.js'
import { ROUTE_METADATA } from './core/decorator/route.js'
import { REACTIVE_METADATA } from './core/decorator/reactive.js'

// ── Public API ──────────────────────────────────────────────────────────────

export { Route } from './core/decorator/route.js'
export { Reactive } from './core/decorator/reactive.js'
export { Guard } from './core/decorator/guard.js'
export { ReactiveApiError, badRequest, unauthorized, forbidden, notFound } from './core/errors.js'
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
   * Register a controller class. Scans its methods for @Route, @Reactive, and
   * @Guard decorators and registers HTTP routes and reactive endpoints accordingly.
   *
   * @param ControllerClass - A class constructor whose methods may be decorated
   *                          with @Route and/or @Reactive and/or @Guard.
   */
  register(ControllerClass: new () => object): this {
    const instance = new ControllerClass()
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
      if (!routeMeta) continue

      const reactiveMeta: ReactiveOptions | undefined =
        reactiveFnStore.get(fn) ??
        (Reflect.getMetadata(REACTIVE_METADATA, proto, methodName) as ReactiveOptions | undefined)

      // Per-route guards (from @Guard decorator)
      const routeGuards: Middleware[] =
        guardFnStore.get(fn) ??
        (Reflect.getMetadata(GUARD_METADATA, proto, methodName) as Middleware[] | undefined) ??
        []

      const handler = (instance as Record<string, unknown>)[methodName] as (
        ctx: Context,
      ) => Promise<unknown>

      // Register HTTP route with Fastify
      this.fastify.route({
        method: routeMeta.method,
        url: routeMeta.path,
        handler: async (req, reply) => {
          const ctx: Context = {
            params: req.params as Record<string, string>,
            query: req.query as Record<string, string>,
            body: req.body,
            headers: req.headers as Record<string, string>,
          }

          try {
            // Run global middlewares then route guards in order
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
        },
      })

      this.registeredRoutes.push({ method: routeMeta.method, path: routeMeta.path, reactive: !!reactiveMeta })

      // Register reactive endpoint if @Reactive is present
      if (reactiveMeta) {
        const endpoint: ReactiveEndpoint = {
          routePath: routeMeta.path,
          options: reactiveMeta,
          handler: (ctx: Context) => handler.call(instance, ctx),
        }
        this.engine.registerEndpoint(endpoint)
        this.reactivePatterns.push(routeMeta.path)
      }
    }

    return this
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
      this.transport = new WebSocketTransport(this.engine, this.reactivePatterns)
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
