import type {
  ChangeEvent,
  Context,
  DatabaseAdapter,
  PushFn,
  ReactiveEndpoint,
} from '../types.js'
import { ReactiveApiError } from '../errors.js'

interface Subscription {
  /** The concrete path the client subscribed to (e.g. '/orders/123/live') */
  path: string
  /** Context built from the subscribed path */
  ctx: Context
  /** Function to call when a push is ready */
  pushFn: PushFn
}

/**
 * Core reactive engine.
 *
 * Responsibilities:
 * 1. Holds the registry of @Reactive endpoints
 * 2. Subscribes to the DatabaseAdapter for each watched table
 * 3. On a ChangeEvent, fans out to matching subscribers after applying filters
 * 4. Supports optional per-subscriber debouncing
 */
export class ReactiveEngine {
  private readonly endpoints: ReactiveEndpoint[] = []
  /** clientId → Subscription */
  private readonly subscriptions: Map<string, Subscription> = new Map()
  /** table → adapter unsubscribe fn */
  private readonly tableWatchers: Map<string, () => void> = new Map()
  /** "clientId:path" → debounce timer id */
  private readonly debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

  constructor(private readonly adapter: DatabaseAdapter) {}

  /**
   * Register a reactive endpoint so the engine can fan-out pushes to subscribers.
   */
  registerEndpoint(endpoint: ReactiveEndpoint): void {
    this.endpoints.push(endpoint)

    const tables = Array.isArray(endpoint.options.watch)
      ? endpoint.options.watch
      : [endpoint.options.watch]

    for (const table of tables) {
      this.setupTableWatcher(table)
    }
  }

  /**
   * Subscribe a WebSocket client to a path.
   * When the watched table(s) change and the filter passes, pushFn is called.
   *
   * @param clientId - Unique identifier for the client connection
   * @param path     - The concrete path the client subscribed to
   * @param ctx      - Context built from the subscribed path
   * @param pushFn   - Callback to deliver data to the client
   */
  subscribe(clientId: string, path: string, ctx: Context, pushFn: PushFn): void {
    this.subscriptions.set(clientId, { path, ctx, pushFn })
  }

  /**
   * Remove a client's subscription and clean up any pending debounce timers.
   */
  unsubscribe(clientId: string): void {
    this.subscriptions.delete(clientId)

    // Clean up any pending debounce timers for this client
    for (const key of this.debounceTimers.keys()) {
      if (key.startsWith(`${clientId}:`)) {
        clearTimeout(this.debounceTimers.get(key))
        this.debounceTimers.delete(key)
      }
    }
  }

  /**
   * Tear down all table watchers. Call this when the app shuts down.
   */
  destroy(): void {
    for (const unsubscribe of this.tableWatchers.values()) {
      unsubscribe()
    }
    this.tableWatchers.clear()

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private setupTableWatcher(table: string): void {
    if (this.tableWatchers.has(table)) return // already watching

    const unsubscribe = this.adapter.onChange(table, (event) => {
      this.onChangeEvent(event)
    })
    this.tableWatchers.set(table, unsubscribe)
  }

  private onChangeEvent(event: ChangeEvent): void {
    // Find endpoints that watch this table
    const matchingEndpoints = this.endpoints.filter((ep) => {
      const tables = Array.isArray(ep.options.watch)
        ? ep.options.watch
        : [ep.options.watch]
      return tables.includes(event.table)
    })

    for (const endpoint of matchingEndpoints) {
      // Find all subscribers that are on this endpoint's route path
      for (const [clientId, sub] of this.subscriptions) {
        if (!pathMatchesPattern(sub.path, endpoint.routePath)) continue

        // Apply optional filter
        if (endpoint.options.filter) {
          try {
            if (!endpoint.options.filter(event, sub.ctx)) continue
          } catch (err) {
            // Filter threw — skip this subscriber rather than crashing
            continue
          }
        }

        this.schedulePush(clientId, endpoint, sub, event)
      }
    }
  }

  private schedulePush(
    clientId: string,
    endpoint: ReactiveEndpoint,
    sub: Subscription,
    _event: ChangeEvent,
  ): void {
    const debounceMs = endpoint.options.debounce

    if (debounceMs !== undefined && debounceMs > 0) {
      const timerKey = `${clientId}:${sub.path}`
      const existing = this.debounceTimers.get(timerKey)
      if (existing !== undefined) clearTimeout(existing)

      const timer = setTimeout(() => {
        this.debounceTimers.delete(timerKey)
        this.executePush(endpoint, sub)
      }, debounceMs)

      this.debounceTimers.set(timerKey, timer)
    } else {
      this.executePush(endpoint, sub)
    }
  }

  private executePush(endpoint: ReactiveEndpoint, sub: Subscription): void {
    endpoint.handler(sub.ctx).then(
      (data) => sub.pushFn(sub.path, data),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        throw new ReactiveApiError('HANDLER_ERROR', `Reactive handler failed: ${message}`)
      },
    )
  }
}

// ---------------------------------------------------------------------------
// Path matching utility
// ---------------------------------------------------------------------------

/**
 * Returns true if a concrete path matches a route pattern with named params.
 *
 * pathMatchesPattern('/orders/123/live', '/orders/:userId/live') → true
 * pathMatchesPattern('/orders/123/live', '/items/:id/live')      → false
 */
export function pathMatchesPattern(concretePath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex special chars except *
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '([^/]+)') // :param → capture group

  const regex = new RegExp(`^${regexStr}$`)
  return regex.test(concretePath)
}

/**
 * Extract named path params from a concrete path given a route pattern.
 *
 * extractParams('/orders/123/live', '/orders/:userId/live') → { userId: '123' }
 */
export function extractParams(concretePath: string, pattern: string): Record<string, string> {
  const paramNames: string[] = []
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
      paramNames.push(name)
      return '([^/]+)'
    })

  const regex = new RegExp(`^${regexStr}$`)
  const match = concretePath.match(regex)
  if (!match) return {}

  return Object.fromEntries(paramNames.map((name, i) => [name, match[i + 1]]))
}
