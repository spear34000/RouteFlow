import type { Middleware } from '../core/types.js'
import { ReactiveApiError } from '../core/errors.js'

export interface RateLimitOptions {
  /**
   * Maximum requests allowed per `windowMs`. Default: `100`.
   */
  max?: number
  /**
   * Window size in milliseconds. Default: `60_000` (1 minute).
   */
  windowMs?: number
  /**
   * Derive the rate-limit key from the request context.
   * Defaults to `x-forwarded-for` → `x-real-ip` → `'unknown'`.
   *
   * **Security**: `x-forwarded-for` can be spoofed by clients unless your
   * infrastructure (load balancer / reverse proxy) strips or overwrites it.
   * In production, supply a `keyBy` that reads a header set exclusively by
   * a trusted proxy (e.g. Cloudflare's `cf-connecting-ip`) or uses a
   * network-layer source IP from your platform's context.
   */
  keyBy?: (ctx: import('../core/types.js').Context) => string
  /**
   * Error message included in the 429 response. Default: `'Too many requests'`.
   */
  message?: string
}

interface Bucket {
  count: number
  resetAt: number
}

/**
 * In-memory sliding-window rate limiter middleware factory.
 *
 * Uses a fixed-window strategy: each unique client key gets a counter that
 * resets after `windowMs`. The sweep interval runs every `windowMs` to
 * evict expired buckets and prevent unbounded memory growth.
 *
 * For multi-process deployments, replace with a shared-store strategy
 * (e.g. Redis INCR + EXPIRE) via the `keyBy` option to route all traffic
 * through a single counting layer.
 *
 * @example
 * ```ts
 * import { createApp, rateLimit } from 'routeflow-api'
 *
 * const app = createApp({ adapter, port: 3000 })
 *
 * // Global: 200 req/min per IP
 * app.use(rateLimit({ max: 200, windowMs: 60_000 }))
 *
 * // Per-route guard: tighter limit on write endpoints
 * class ItemController {
 *   @Guard(rateLimit({ max: 20, windowMs: 60_000 }))
 *   @Post('/items')
 *   async createItem(ctx) { ... }
 * }
 * ```
 */
export function rateLimit(options: RateLimitOptions = {}): Middleware {
  const max       = options.max       ?? 100
  const windowMs  = options.windowMs  ?? 60_000
  const message   = options.message   ?? 'Too many requests'
  const keyBy     = options.keyBy     ??
    ((ctx) =>
      ctx.headers['x-forwarded-for'] ??
      ctx.headers['x-real-ip']       ??
      'unknown')

  const buckets = new Map<string, Bucket>()

  // Sweep expired buckets once per window to prevent unbounded growth.
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key)
    }
  }, windowMs)

  // Do not keep the Node.js event loop alive just for cleanup.
  if (typeof sweep.unref === 'function') sweep.unref()

  return async (ctx, next) => {
    const key = keyBy(ctx)
    const now = Date.now()

    let bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      // Start a fresh window
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(key, bucket)
    }

    if (bucket.count >= max) {
      throw new ReactiveApiError('RATE_LIMITED', message, 429)
    }

    bucket.count++
    await next()
  }
}
