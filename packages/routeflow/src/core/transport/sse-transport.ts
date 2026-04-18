import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { ReactiveEngine } from '../reactive/engine.js'
import { extractParams, normalizeSubscriptionPath, pathMatchesPattern } from '../reactive/engine.js'
import { sanitizeStringRecord } from '../sanitize.js'
import type { Context } from '../types.js'
import { ReactiveApiError } from '../errors.js'

/**
 * Server-Sent Events transport layer.
 *
 * Clients connect via a GET request to `/_sse/subscribe?path=<encodedPath>`.
 * The server sends a stream of `data:` events in the standard SSE format.
 *
 * Event format:
 * ```
 * id: 42
 * data: {"type":"update","path":"/orders/123/live","data":[...]}
 *
 * ```
 *
 * Each event includes an incrementing `id:` line so the browser's native
 * `EventSource` can send `Last-Event-ID` on reconnect.  Because the server
 * always pushes a full snapshot (or delta) on re-subscribe, the `Last-Event-ID`
 * value is informational — no replay is needed, but the header confirms the
 * client had received events up to that point.
 *
 * A `retry: 3000` directive is sent on connection to hint the browser to
 * reconnect within 3 seconds after an unexpected disconnect.
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
  /** Per-client monotonically increasing event sequence number */
  private readonly sequences: Map<string, number> = new Map()
  /** Per-client keepalive intervals to keep proxies from buffering/closing */
  private readonly keepAliveTimers: Map<string, ReturnType<typeof setInterval>> = new Map()

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

      let decodedPath: string
      try {
        decodedPath = decodeURIComponent(path)
      } catch {
        reply.code(400)
        throw new ReactiveApiError('SSE_INVALID_PATH', 'Query param "path" contains invalid percent-encoding')
      }

      if (/[\r\n]/.test(decodedPath)) {
        reply.code(400)
        throw new ReactiveApiError('SSE_INVALID_PATH', 'Path must not contain newline characters')
      }

      const normalized = normalizeSubscriptionPath(decodedPath)
      const pattern = this.routePatterns.find((p) => pathMatchesPattern(normalized.pathname, p))

      if (!pattern) {
        reply.code(404)
        throw new ReactiveApiError(
          'SSE_NO_REACTIVE_ENDPOINT',
          `No reactive endpoint found for path: ${decodedPath}`,
        )
      }

      const params = extractParams(normalized.pathname, pattern)

      // Build a clean query object — strip 'path' and guard against prototype
      // pollution via keys like '__proto__', 'constructor', 'prototype'.
      const clientQuery = sanitizeStringRecord({
        ...normalized.query,
        ...Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'path')),
      })

      const ctx: Context = {
        params,
        query: clientQuery,
        body: undefined,
        headers: sanitizeStringRecord(req.headers, { allowArrays: true }),
      }

      const clientId = randomUUID()

      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx buffering
      })

      // Tell the browser's EventSource to reconnect within 3 s after a drop.
      // The initial snapshot on re-subscribe already recovers state, so no
      // replay buffer is needed — but the retry hint avoids the default 3 s
      // browser reconnect delay being opaque/undocumented.
      reply.raw.write('retry: 3000\n')

      // Send initial comment to establish the connection (also flushes headers).
      reply.raw.write(': connected\n\n')

      this.connections.set(clientId, reply)
      this.sequences.set(clientId, 0)
      this.startKeepAlive(clientId, reply)

      // Log the Last-Event-ID the client reported so future logic can use it
      // for selective replay if needed. Currently unused — the snapshot on
      // (re-)subscribe is always a full consistent state.
      // const lastEventId = (req.headers['last-event-id'] as string | undefined) ?? null

      const pushFn = (subscribedPath: string, data: unknown): void => {
        if (reply.raw.destroyed) return
        const seq = (this.sequences.get(clientId) ?? 0) + 1
        this.sequences.set(clientId, seq)
        const payload = JSON.stringify({ type: 'update', path: subscribedPath, data })
        // id: allows EventSource to send Last-Event-ID on reconnect
        reply.raw.write(`id: ${seq}\ndata: ${payload}\n\n`)
      }

      this.engine.subscribe(clientId, decodedPath, ctx, pushFn)

      // Cleanup when client disconnects
      req.raw.on('close', () => {
        this.cleanupConnection(clientId)
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
    for (const clientId of this.connections.keys()) this.cleanupConnection(clientId)
    this.connections.clear()
    this.sequences.clear()
    this.keepAliveTimers.clear()
  }

  private startKeepAlive(clientId: string, reply: FastifyReply): void {
    const timer = setInterval(() => {
      if (reply.raw.destroyed) {
        this.cleanupConnection(clientId)
        return
      }
      // SSE comments are ignored by the client but keep intermediaries from
      // considering the stream idle and closing the socket.
      reply.raw.write(': keep-alive\n\n')
    }, 25_000)
    this.keepAliveTimers.set(clientId, timer)
  }

  private cleanupConnection(clientId: string): void {
    const reply = this.connections.get(clientId)
    const timer = this.keepAliveTimers.get(clientId)
    if (timer !== undefined) {
      clearInterval(timer)
      this.keepAliveTimers.delete(clientId)
    }
    this.engine.unsubscribe(clientId)
    this.connections.delete(clientId)
    this.sequences.delete(clientId)
    if (reply && !reply.raw.destroyed) reply.raw.end()
  }

}
