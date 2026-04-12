import 'reflect-metadata'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { FastifyInstance } from 'fastify'
import type { AppOptions, Context, ReactiveEndpoint } from './core/types.js'
import { ROUTE_METADATA, routeFnStore } from './core/decorator/route.js'
import { REACTIVE_METADATA, reactiveFnStore } from './core/decorator/reactive.js'
import type { RouteMetadata, ReactiveOptions } from './core/types.js'
import { ReactiveEngine } from './core/reactive/engine.js'
import { WebSocketTransport } from './core/transport/websocket-transport.js'
import { SseTransport } from './core/transport/sse-transport.js'
import { ReactiveApiError } from './core/errors.js'

export { Route } from './core/decorator/route.js'
export { Reactive } from './core/decorator/reactive.js'
export { ReactiveApiError } from './core/errors.js'
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
  ReactiveOptions,
  AppOptions,
  HttpMethod,
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

type AnyTransport = WebSocketTransport | SseTransport

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

  constructor(options: AppOptions) {
    this.options = {
      transport: 'websocket',
      port: 3000,
      ...options,
    }
    this.fastify = Fastify({ logger: false })
    this.engine = new ReactiveEngine(this.options.adapter)

    // Register a global error handler that serialises ReactiveApiError properly
    this.fastify.setErrorHandler((error, _req, reply) => {
      if (error instanceof ReactiveApiError) {
        const status = (error as ReactiveApiError & { statusCode?: number }).statusCode ?? 500
        reply.status(status).send({ error: error.code, message: error.message })
      } else {
        reply.status(500).send({ error: 'INTERNAL_ERROR', message: error.message })
      }
    })
  }

  /**
   * Register a controller class. Scans its methods for @Route and @Reactive
   * decorators and registers HTTP routes and reactive endpoints accordingly.
   *
   * @param ControllerClass - A class constructor whose methods may be decorated
   *                          with @Route and/or @Reactive.
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
            const result = await handler.call(instance, ctx)
            return reply.send(result)
          } catch (err) {
            if (err instanceof ReactiveApiError) throw err
            const msg = err instanceof Error ? err.message : String(err)
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

  /**
   * Access the underlying Fastify instance for supplemental routes such as
   * health checks, static assets, or demo pages.
   */
  getFastify(): FastifyInstance {
    return this.fastify
  }

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

/**
 * Create a new RouteFlow application.
 *
 * @example
 * ```ts
 * const app = createApp({ adapter: new MemoryAdapter(), port: 3000 })
 * app.register(MyController)
 * await app.listen()
 * ```
 */
export function createApp(options: AppOptions): ReactiveApp {
  return new ReactiveApp(options)
}
