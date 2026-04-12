import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { ReactiveEngine } from '../reactive/engine.js'
import { extractParams } from '../reactive/engine.js'
import type { Context } from '../types.js'
import { ReactiveApiError } from '../errors.js'

/**
 * Server-Sent Events transport layer.
 *
 * Clients connect via a GET request to `/_sse/subscribe?path=<encodedPath>`.
 * The server sends a stream of `data:` events in the standard SSE format.
 *
 * Event format (one JSON object per `data:` line):
 * ```
 * data: {"type":"update","path":"/orders/123/live","data":[...]}
 *
 * ```
 *
 * Unlike WebSocket, SSE is strictly server-to-client (unidirectional).
 * The subscribed path is passed as a query param on the initial GET request.
 *
 * Advantages over WebSocket in some environments:
 * - Works over plain HTTP/1.1 (no upgrade required)
 * - Automatic reconnection handled natively by the browser `EventSource`
 * - Firewall/proxy friendly
 */
export class SseTransport {
  /** clientId → reply (kept open) */
  private readonly connections: Map<string, FastifyReply> = new Map()

  constructor(
    private readonly engine: ReactiveEngine,
    private readonly routePatterns: string[],
  ) {}

  /**
   * Register the SSE subscription endpoint on the Fastify instance.
   * Must be called before `fastify.listen()`.
   */
  register(fastify: FastifyInstance): void {
    fastify.get('/_sse/subscribe', async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as Record<string, string>
      const path = query['path']

      if (!path) {
        throw new ReactiveApiError('SSE_MISSING_PATH', 'Query param "path" is required')
      }

      const decodedPath = decodeURIComponent(path)
      const pattern = this.routePatterns.find((p) => this.matchesPattern(decodedPath, p))

      if (!pattern) {
        reply.code(404)
        throw new ReactiveApiError(
          'SSE_NO_REACTIVE_ENDPOINT',
          `No reactive endpoint found for path: ${decodedPath}`,
        )
      }

      const params = extractParams(decodedPath, pattern)
      const clientQuery = { ...query }
      delete clientQuery['path']

      const ctx: Context = {
        params,
        query: clientQuery,
        body: undefined,
        headers: req.headers as Record<string, string>,
      }

      const clientId = randomUUID()

      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx buffering
      })

      // Send initial comment to establish connection
      reply.raw.write(': connected\n\n')

      this.connections.set(clientId, reply)

      const pushFn = (subscribedPath: string, data: unknown): void => {
        if (reply.raw.destroyed) return
        const payload = JSON.stringify({ type: 'update', path: subscribedPath, data })
        reply.raw.write(`data: ${payload}\n\n`)
      }

      this.engine.subscribe(clientId, decodedPath, ctx, pushFn)

      // Cleanup when client disconnects
      req.raw.on('close', () => {
        this.engine.unsubscribe(clientId)
        this.connections.delete(clientId)
        if (!reply.raw.destroyed) reply.raw.end()
      })

      // Keep the connection open — Fastify needs this to not auto-close
      await new Promise<void>((resolve) => {
        req.raw.on('close', resolve)
        req.raw.on('error', resolve)
      })
    })
  }

  /** Close all open SSE connections. */
  async close(): Promise<void> {
    for (const reply of this.connections.values()) {
      if (!reply.raw.destroyed) reply.raw.end()
    }
    this.connections.clear()
  }

  private matchesPattern(concretePath: string, pattern: string): boolean {
    const regexStr = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '([^/]+)')
    return new RegExp(`^${regexStr}$`).test(concretePath)
  }
}
