import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { DatabaseAdapter, ChangeEvent } from '../../core/types.js'

export interface WebhookAdapterOptions {
  /**
   * Path to register the webhook endpoint. Default: `'/_webhook'`.
   */
  path?: string
  /**
   * HMAC-SHA256 signing secret.
   * When set, incoming requests must include a valid
   * `X-RouteFlow-Signature` header (`sha256=<hex>`).
   *
   * Set this to prevent arbitrary parties from injecting fake change events.
   */
  secret?: string
  /**
   * Header name used to verify the payload signature.
   * Default: `'x-routeflow-signature'`.
   */
  signatureHeader?: string
}

interface WebhookPayload {
  table: string
  operation: 'INSERT' | 'UPDATE' | 'DELETE'
  new_row?: Record<string, unknown> | null
  old_row?: Record<string, unknown> | null
}

/**
 * HTTP webhook adapter — lets any external service (FastAPI, Django, Rails, Go…)
 * push change events into RouteFlow by POSTing to a dedicated endpoint.
 *
 * @example
 * ```ts
 * import { WebhookAdapter } from 'routeflow-api/adapters/webhook'
 * import { createApp } from 'routeflow-api'
 *
 * const webhook = new WebhookAdapter({ secret: process.env.WEBHOOK_SECRET })
 * const app     = createApp({ adapter: webhook, port: 3000 })
 *
 * // Register the endpoint before listen()
 * webhook.registerWith(app.getFastify())
 *
 * app.register(new OrderController())
 * await app.listen()
 * ```
 *
 * **Payload format** (POST `/_webhook`):
 * ```json
 * {
 *   "table":     "orders",
 *   "operation": "INSERT",
 *   "new_row":   { "id": 1, "status": "pending" },
 *   "old_row":   null
 * }
 * ```
 *
 * **FastAPI example** (Python side):
 * ```python
 * import httpx, hmac, hashlib, json
 *
 * payload = json.dumps({"table": "orders", "operation": "INSERT", "new_row": {...}, "old_row": None})
 * sig = "sha256=" + hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
 * httpx.post("http://routeflow:3000/_webhook",
 *            content=payload,
 *            headers={"Content-Type": "application/json", "X-RouteFlow-Signature": sig})
 * ```
 */
export class WebhookAdapter implements DatabaseAdapter {
  private readonly listeners = new Map<string, Set<(event: ChangeEvent) => void>>()
  private readonly endpointPath: string
  private readonly secret?: string
  private readonly sigHeader: string

  constructor(options: WebhookAdapterOptions = {}) {
    this.endpointPath = options.path           ?? '/_webhook'
    this.secret       = options.secret
    this.sigHeader    = options.signatureHeader ?? 'x-routeflow-signature'
  }

  // ---------------------------------------------------------------------------
  // DatabaseAdapter interface
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.listeners.clear()
  }

  onChange(table: string, callback: (event: ChangeEvent) => void): () => void {
    if (!this.listeners.has(table)) this.listeners.set(table, new Set())
    this.listeners.get(table)!.add(callback)
    return () => this.listeners.get(table)?.delete(callback)
  }

  // ---------------------------------------------------------------------------
  // Fastify registration
  // ---------------------------------------------------------------------------

  /**
   * Register the `POST {path}` endpoint on the given Fastify instance.
   * Call this before `app.listen()`.
   *
   * @example
   * ```ts
   * webhook.registerWith(app.getFastify())
   * await app.listen()
   * ```
   */
  registerWith(fastify: FastifyInstance): void {
    // Register a content-type parser that captures the raw bytes so we can
    // verify the HMAC signature before JSON-parsing the body.
    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 1_048_576 },
      (_req, body, done) => done(null, body),
    )

    fastify.post(this.endpointPath, async (req, reply) => {
      const rawBody = req.body as Buffer

      // Signature verification
      if (this.secret) {
        const sig = (req.headers as Record<string, string>)[this.sigHeader] ?? ''
        if (!this.verifySignature(rawBody, sig)) {
          return reply.status(401).send({ error: 'Invalid or missing signature.' })
        }
      }

      let payload: unknown
      try {
        payload = JSON.parse(rawBody.toString('utf8'))
      } catch {
        return reply.status(400).send({ error: 'Request body must be valid JSON.' })
      }

      if (!isValidPayload(payload)) {
        return reply
          .status(400)
          .send({ error: 'Invalid payload. Required fields: table (string), operation (INSERT|UPDATE|DELETE).' })
      }

      this.dispatch({
        table:     payload.table,
        operation: payload.operation,
        newRow:    payload.new_row ?? null,
        oldRow:    payload.old_row ?? null,
        timestamp: Date.now(),
      })

      return reply.status(200).send({ ok: true })
    })
  }

  // ---------------------------------------------------------------------------
  // Programmatic emit (testing / internal triggers)
  // ---------------------------------------------------------------------------

  /**
   * Programmatically fire a change event — useful for testing or for
   * triggering reactive pushes from application logic without an HTTP call.
   *
   * @example
   * ```ts
   * webhook.emit('orders', 'INSERT', { id: 42, status: 'pending' })
   * ```
   */
  emit(
    table: string,
    operation: ChangeEvent['operation'],
    newRow: unknown = null,
    oldRow: unknown = null,
  ): void {
    this.dispatch({ table, operation, newRow, oldRow, timestamp: Date.now() })
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private dispatch(event: ChangeEvent): void {
    const cbs = this.listeners.get(event.table)
    if (!cbs) return
    for (const cb of cbs) {
      try {
        cb(event)
      } catch (err) {
        console.error(`[RouteFlow/webhook] Listener error on table "${event.table}":`, err)
      }
    }
  }

  private verifySignature(rawBody: Buffer, signature: string): boolean {
    // Accept both bare hex and 'sha256=<hex>' formats.
    const hex = signature.startsWith('sha256=') ? signature.slice(7) : signature
    if (!hex) return false
    try {
      const expected = createHmac('sha256', this.secret!).update(rawBody).digest('hex')
      // Both buffers must be the same byte length for timingSafeEqual.
      // hex length must match expected (64 hex chars = 32 bytes SHA-256).
      if (hex.length !== expected.length) return false
      return timingSafeEqual(Buffer.from(hex, 'utf8'), Buffer.from(expected, 'utf8'))
    } catch {
      return false
    }
  }
}

function isValidPayload(value: unknown): value is WebhookPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['table'] === 'string' &&
    (v['operation'] === 'INSERT' ||
      v['operation'] === 'UPDATE' ||
      v['operation'] === 'DELETE')
  )
}
