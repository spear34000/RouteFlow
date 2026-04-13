import { IncomingMessage, Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { ReactiveEngine } from '../reactive/engine.js'
import { extractParams, pathMatchesPattern } from '../reactive/engine.js'
import type { Context } from '../types.js'
import { ReactiveApiError } from '../errors.js'

/** Message sent by the client to subscribe to a reactive path. */
interface SubscribeMessage {
  type: 'subscribe'
  path: string
  /** Optional query params the client wants included in the Context */
  query?: Record<string, string>
}

/** Message sent by the client to cancel a subscription. */
interface UnsubscribeMessage {
  type: 'unsubscribe'
}

/** Message pushed by the server when data changes. */
interface UpdateMessage {
  type: 'update'
  path: string
  data: unknown
}

/** Message sent on error. */
interface ErrorMessage {
  type: 'error'
  code: string
  message: string
}

type ServerMessage = UpdateMessage | ErrorMessage

function isSubscribeMessage(value: unknown): value is SubscribeMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['type'] === 'subscribe' &&
    typeof (value as Record<string, unknown>)['path'] === 'string'
  )
}

function isUnsubscribeMessage(value: unknown): value is UnsubscribeMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['type'] === 'unsubscribe'
  )
}

/**
 * WebSocket transport layer.
 *
 * Attaches a `ws` server to the underlying Node HTTP server. Clients connect
 * and send a subscribe message; the transport builds a Context and registers
 * the subscription with the ReactiveEngine.
 *
 * Protocol:
 * - Client → Server: `{ "type": "subscribe", "path": "/orders/123/live" }`
 * - Server → Client: `{ "type": "update",    "path": "/orders/123/live", "data": [...] }`
 * - Server → Client: `{ "type": "error",     "code": "...", "message": "..." }`
 */
/** Maximum concurrent WebSocket connections. Tune via WS_MAX_CONNECTIONS env var. */
const MAX_CONNECTIONS = Number(process.env['WS_MAX_CONNECTIONS'] ?? 5_000)

export class WebSocketTransport {
  private readonly wss: WebSocketServer
  /** Maps clientId → registered route pattern, for param extraction */
  private readonly clientPatterns: Map<string, string> = new Map()
  /** Live connection count — tracked for DoS protection */
  private connectionCount = 0
  /** Allowed origins for WebSocket upgrades (mirrors HTTP CORS config) */
  private readonly allowedOrigins: boolean | string | string[]

  constructor(
    private readonly engine: ReactiveEngine,
    /** All registered route patterns (e.g. ['/orders/:userId/live']) */
    private readonly routePatterns: string[],
    /** CORS config — same value passed to createApp({ cors }) */
    allowedOrigins: boolean | string | string[] = true,
  ) {
    this.allowedOrigins = allowedOrigins
    // noServer=true so we can attach to Fastify's underlying http.Server manually.
    // maxPayload: reject messages larger than 64 KiB to limit DoS exposure.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))
  }

  /**
   * Attach to the raw Node.js HTTP server so WebSocket upgrade requests are
   * handled alongside Fastify routes.
   *
   * Validates the `Origin` header against the configured CORS policy before
   * completing the upgrade. Requests from disallowed origins are rejected
   * with HTTP 403.
   */
  attach(httpServer: HttpServer): void {
    httpServer.on('upgrade', (req, socket, head) => {
      if (!this.isOriginAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Origin validation
  // ---------------------------------------------------------------------------

  private isOriginAllowed(req: IncomingMessage): boolean {
    // cors: true → allow all origins (including no-origin requests from non-browser clients)
    if (this.allowedOrigins === true) return true

    const origin = req.headers['origin']

    // Non-browser clients (e.g. server-to-server) send no Origin header.
    // Allow them unless cors is explicitly set to a restricted list/string.
    if (!origin) return this.allowedOrigins === true

    if (typeof this.allowedOrigins === 'string') {
      return origin === this.allowedOrigins
    }
    if (Array.isArray(this.allowedOrigins)) {
      return this.allowedOrigins.includes(origin)
    }
    // cors: false → reject all browser upgrade requests
    return false
  }

  /** Gracefully close all connections. */
  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()))
    })
  }

  // ---------------------------------------------------------------------------
  // Connection handling
  // ---------------------------------------------------------------------------

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    // Reject connections beyond the cap
    if (this.connectionCount >= MAX_CONNECTIONS) {
      ws.close(1008, 'Server at capacity')
      return
    }
    this.connectionCount++

    const clientId = randomUUID()

    ws.on('message', (raw) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString())
      } catch {
        this.sendError(ws, 'INVALID_JSON', 'Message must be valid JSON')
        return
      }

      if (isUnsubscribeMessage(parsed)) {
        this.engine.unsubscribe(clientId)
        this.clientPatterns.delete(clientId)
        return
      }

      if (!isSubscribeMessage(parsed)) {
        this.sendError(ws, 'INVALID_MESSAGE', 'Expected { type: "subscribe", path: string }')
        return
      }

      this.handleSubscribe(ws, clientId, parsed)
    })

    ws.on('close', () => {
      this.connectionCount--
      this.engine.unsubscribe(clientId)
      this.clientPatterns.delete(clientId)
    })

    ws.on('error', (err) => {
      this.connectionCount--
      this.engine.unsubscribe(clientId)
      this.clientPatterns.delete(clientId)
      // ws errors are expected (client disconnect); just log in dev
      if (process.env['NODE_ENV'] !== 'production') {
        console.error('[RouteFlow] WebSocket error:', err.message)
      }
    })
  }

  private handleSubscribe(ws: WebSocket, clientId: string, msg: SubscribeMessage): void {
    const { path, query = {} } = msg

    // Find the matching route pattern
    const pattern = this.routePatterns.find((p) => pathMatchesPattern(path, p))

    if (!pattern) {
      this.sendError(ws, 'NO_REACTIVE_ENDPOINT', `No reactive endpoint found for path: ${path}`)
      return
    }

    const params = extractParams(path, pattern)

    const ctx: Context = {
      params,
      query,
      body: undefined,
      headers: {},
    }

    const pushFn = (subscribedPath: string, data: unknown): void => {
      if (ws.readyState !== WebSocket.OPEN) return
      const msg: UpdateMessage = { type: 'update', path: subscribedPath, data }
      ws.send(JSON.stringify(msg))
    }

    // Unsubscribe any previous subscription for this client before re-subscribing
    this.engine.unsubscribe(clientId)
    this.clientPatterns.set(clientId, pattern)
    this.engine.subscribe(clientId, path, ctx, pushFn)
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState !== WebSocket.OPEN) return
    const msg: ErrorMessage = { type: 'error', code, message }
    ws.send(JSON.stringify(msg))
  }
}
