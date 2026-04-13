import type {
  ChangeEvent,
  Context,
  DatabaseAdapter,
  PushFn,
  ReactiveEndpoint,
} from '../types.js'

// Compiled path-pattern regexes are reused across all ChangeEvents.
const patternRegexCache = new Map<string, RegExp>()

interface Subscription {
  path: string
  ctx: Context
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
  private readonly subscriptions = new Map<string, Subscription>()
  /** table → adapter unsubscribe fn */
  private readonly tableWatchers = new Map<string, () => void>()
  /** timerKey → timer */
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** clientId → Set of timerKeys — O(1) cleanup on disconnect */
  private readonly clientTimers = new Map<string, Set<string>>()

  constructor(private readonly adapter: DatabaseAdapter) {}

  registerEndpoint(endpoint: ReactiveEndpoint): void {
    this.endpoints.push(endpoint)
    for (const table of normalizeWatch(endpoint.options.watch)) {
      this.setupTableWatcher(table)
    }
  }

  subscribe(clientId: string, path: string, ctx: Context, pushFn: PushFn): void {
    this.subscriptions.set(clientId, { path, ctx, pushFn })
  }

  unsubscribe(clientId: string): void {
    this.subscriptions.delete(clientId)

    const timerKeys = this.clientTimers.get(clientId)
    if (timerKeys) {
      for (const key of timerKeys) {
        clearTimeout(this.debounceTimers.get(key))
        this.debounceTimers.delete(key)
      }
      this.clientTimers.delete(clientId)
    }
  }

  destroy(): void {
    for (const unsubscribe of this.tableWatchers.values()) unsubscribe()
    this.tableWatchers.clear()
    for (const timer of this.debounceTimers.values()) clearTimeout(timer)
    this.debounceTimers.clear()
    this.clientTimers.clear()
  }

  private setupTableWatcher(table: string): void {
    if (this.tableWatchers.has(table)) return
    this.tableWatchers.set(table, this.adapter.onChange(table, (e) => this.onChangeEvent(e)))
  }

  private onChangeEvent(event: ChangeEvent): void {
    for (const endpoint of this.endpoints) {
      if (!normalizeWatch(endpoint.options.watch).includes(event.table)) continue

      for (const [clientId, sub] of this.subscriptions) {
        if (!pathMatchesPattern(sub.path, endpoint.routePath)) continue

        if (endpoint.options.filter) {
          try {
            if (!endpoint.options.filter(event, sub.ctx)) continue
          } catch {
            continue
          }
        }

        this.schedulePush(clientId, endpoint, sub)
      }
    }
  }

  private schedulePush(
    clientId: string,
    endpoint: ReactiveEndpoint,
    sub: Subscription,
  ): void {
    const debounceMs = endpoint.options.debounce

    if (debounceMs !== undefined && debounceMs > 0) {
      const timerKey = `${clientId}:${sub.path}`
      const existing = this.debounceTimers.get(timerKey)
      if (existing !== undefined) clearTimeout(existing)

      const timer = setTimeout(() => {
        this.debounceTimers.delete(timerKey)
        this.clientTimers.get(clientId)?.delete(timerKey)
        void this.executePush(endpoint, sub)
      }, debounceMs)

      this.debounceTimers.set(timerKey, timer)
      if (!this.clientTimers.has(clientId)) this.clientTimers.set(clientId, new Set())
      this.clientTimers.get(clientId)!.add(timerKey)
    } else {
      void this.executePush(endpoint, sub)
    }
  }

  private async executePush(endpoint: ReactiveEndpoint, sub: Subscription): Promise<void> {
    try {
      const data = await endpoint.handler(sub.ctx)
      sub.pushFn(sub.path, data)
    } catch (err: unknown) {
      // Log the error but do not crash the server — the subscription stays alive.
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[RouteFlow] Reactive handler error on ${sub.path}: ${message}`)
    }
  }
}

/** Normalise `watch` to a guaranteed string array. */
function normalizeWatch(watch: string | string[]): string[] {
  return Array.isArray(watch) ? watch : [watch]
}

/**
 * Returns true if a concrete path matches a route pattern with named params.
 * Compiled regexes are cached by pattern string.
 *
 * pathMatchesPattern('/orders/123/live', '/orders/:userId/live') → true
 * pathMatchesPattern('/orders/123/live', '/items/:id/live')      → false
 */
export function pathMatchesPattern(concretePath: string, pattern: string): boolean {
  let regex = patternRegexCache.get(pattern)
  if (!regex) {
    const src = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '([^/]+)')
    regex = new RegExp(`^${src}$`)
    patternRegexCache.set(pattern, regex)
  }
  return regex.test(concretePath)
}

/**
 * Extract named path params from a concrete path given a route pattern.
 *
 * extractParams('/orders/123/live', '/orders/:userId/live') → { userId: '123' }
 */
export function extractParams(concretePath: string, pattern: string): Record<string, string> {
  const paramNames: string[] = []
  const src = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
      paramNames.push(name)
      return '([^/]+)'
    })

  const match = concretePath.match(new RegExp(`^${src}$`))
  if (!match) return {}
  return Object.fromEntries(paramNames.map((name, i) => [name, match[i + 1]]))
}
