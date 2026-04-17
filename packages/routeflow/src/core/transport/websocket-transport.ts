import { IncomingMessage, Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { ReactiveEngine } from '../reactive/engine.js'
import { extractParams, normalizeSubscriptionPath, pathMatchesPattern } from '../reactive/engine.js'
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

/**
 * Server-side ping interval in ms.
 * Keeps the connection alive through NAT/firewall idle timeouts and detects
 * zombie connections (mobile clients that went to background without closing).
 * Tune via WS_PING_INTERVAL_MS env var.
 */
const PING_INTERVAL_MS = Number(process.env['WS_PING_INTERVAL_MS'] ?? 30_000)

/**
 * How long to wait for a pong reply before closing the connection.
 * If the client does not respond within this window it is considered dead.
 * Tune via WS_PONG_TIMEOUT_MS env var.
 */
const PONG_TIMEOUT_MS = Number(process.env['WS_PONG_TIMEOUT_MS'] ?? 5_000)

export class WebSocketTransport {
  private readonly wss: WebSocketServer
  /** Maps clientId → registered route pattern, for param extraction */
  private readonly clientPatterns: Map<string, string> = new Map()
  /** Live connection count — tracked for DoS protection */
  private connectionCount = 0
  /** Allowed origins for WebSocket upgrades (mirrors HTTP CORS config) */
  private readonly allowedOrigins: boolean | string | string[]
  /** Presence callbacks from AppOptions */
  private readonly onConnect?: (clientId: string, req: IncomingMessage) => void
  private readonly onDisconnect?: (clientId: string) => void
  /** Per-connection ping timers — cleared on disconnect */
  private readonly pingIntervals: Map<string, ReturnType<typeof setInterval>> = new Map()
  /** Per-connection pong-timeout timers — cleared when pong arrives */
  private readonly pongTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map()

  constructor(
    private readonly engine: ReactiveEngine,
    /** All registered route patterns (e.g. ['/orders/:userId/live']) */
    private readonly routePatterns: string[],
    /** CORS config — same value passed to createApp({ cors }) */
    allowedOrigins: boolean | string | string[] = true,
    onConnect?: (clientId: string, req: IncomingMessage) => void,
    onDisconnect?: (clientId: string) => void,
  ) {
    this.allowedOrigins = allowedOrigins
    this.onConnect    = onConnect
    this.onDisconnect = onDisconnect
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

    // The Origin header must be a single value; comma-separated (multi-value)
    // Origins are illegal per RFC 6454 but some proxies inject them. Reject to
    // prevent bypass via "allowed,evil.com" tricks.
    const rawOrigin = req.headers['origin']
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin
    if (origin && origin.includes(',')) return false

    // Non-browser clients (e.g. server-to-server) send no Origin header.
    // Allow them when cors is not explicitly restricted (true = open policy already
    // returned above; we reach here only for string/array/false).
    if (!origin) return this.allowedOrigins !== false

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
    // Cancel all outstanding heartbeat timers before closing the server.
    for (const clientId of this.pingIntervals.keys()) this.stopHeartbeat(clientId)
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()))
    })
  }

  // ---------------------------------------------------------------------------
  // Heartbeat helpers
  // ---------------------------------------------------------------------------

  /**
   * Start a server-side ping/pong heartbeat for a connection.
   *
   * Every PING_INTERVAL_MS the server sends a WebSocket ping frame.
   * If the client does not reply with a pong within PONG_TIMEOUT_MS the
   * connection is forcibly terminated — this cleans up zombie connections
   * from mobile clients that backgrounded the app without closing the socket.
   */
  private startHeartbeat(clientId: string, ws: WebSocket): void {
    const interval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat(clientId)
        return
      }
      // Arm the pong-timeout before sending the ping
      const timeout = setTimeout(() => {
        // No pong received — the connection is dead; terminate it
        ws.terminate()
      }, PONG_TIMEOUT_MS)
      this.pongTimeouts.set(clientId, timeout)
      ws.ping()
    }, PING_INTERVAL_MS)

    this.pingIntervals.set(clientId, interval)
  }

  /** Cancel all heartbeat timers for a connection. */
  private stopHeartbeat(clientId: string): void {
    const interval = this.pingIntervals.get(clientId)
    if (interval !== undefined) {
      clearInterval(interval)
      this.pingIntervals.delete(clientId)
    }
    const timeout = this.pongTimeouts.get(clientId)
    if (timeout !== undefined) {
      clearTimeout(timeout)
      this.pongTimeouts.delete(clientId)
    }
  }

  // ---------------------------------------------------------------------------
  // Connection handling
  // ---------------------------------------------------------------------------

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Reject connections beyond the cap
    if (this.connectionCount >= MAX_CONNECTIONS) {
      ws.close(1008, 'Server at capacity')
      return
    }
    this.connectionCount++

    const clientId = randomUUID()
    let cleaned = false
    const cleanupClient = (): void => {
      if (cleaned) return
      cleaned = true
      this.connectionCount = Math.max(0, this.connectionCount - 1)
      this.stopHeartbeat(clientId)
      this.engine.unsubscribe(clientId)
      this.clientPatterns.delete(clientId)
      try { this.onDisconnect?.(clientId) } catch { /* never crash on user hook */ }
    }

    // Notify the application of the new connection — used for presence tracking.
    try { this.onConnect?.(clientId, req) } catch { /* never crash on user hook */ }

    // Start heartbeat to detect zombie connections (mobile background, NAT drops).
    this.startHeartbeat(clientId, ws)

    // Clear the pong-timeout when the client responds — connection is alive.
    ws.on('pong', () => {
      const timeout = this.pongTimeouts.get(clientId)
      if (timeout !== undefined) {
        clearTimeout(timeout)
        this.pongTimeouts.delete(clientId)
      }
    })

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
      cleanupClient()
    })

    ws.on('error', (err) => {
      cleanupClient()
      // ws errors are expected (client disconnect); just log in dev
      if (process.env['NODE_ENV'] !== 'production') {
        console.error('[RouteFlow] WebSocket error:', err.message)
      }
    })
  }

  private handleSubscribe(ws: WebSocket, clientId: string, msg: SubscribeMessage): void {
    const { path, query = {} } = msg
    const normalized = normalizeSubscriptionPath(path)
    const mergedQuery = { ...normalized.query, ...query }

    // Find the matching route pattern
    const pattern = this.routePatterns.find((p) => pathMatchesPattern(normalized.pathname, p))

    if (!pattern) {
      this.sendError(ws, 'NO_REACTIVE_ENDPOINT', `No reactive endpoint found for path: ${path}`)
      return
    }

    const params = extractParams(normalized.pathname, pattern)

    const ctx: Context = {
      params,
      query: mergedQuery,
      body: undefined,
      headers: {},
    }

    const pushFn = (subscribedPath: string, data: unknown): void => {
      if (ws.readyState !== WebSocket.OPEN) return
      const msg: UpdateMessage = { type: 'update', path: subscribedPath, data }
      ws.send(JSON.stringify(msg))
    }

    // Fast path: accept a pre-serialized string from the fan-out engine to avoid
    // N repeated JSON.stringify calls when many clients subscribe to the same path.
    const pushSerializedFn = (serialized: string): void => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(serialized)
    }

    // Unsubscribe any previous subscription for this client before re-subscribing
    this.engine.unsubscribe(clientId)
    this.clientPatterns.set(clientId, pattern)
    this.engine.subscribe(clientId, path, ctx, pushFn, pushSerializedFn)
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState !== WebSocket.OPEN) return
    const msg: ErrorMessage = { type: 'error', code, message }
    ws.send(JSON.stringify(msg))
  }
}
