import type {
  ChangeEvent,
  Context,
  DatabaseAdapter,
  PushFn,
  ReactiveEndpoint,
} from '../types.js'

// ── Pattern cache ──────────────────────────────────────────────────────────────
// Regex + param-name list are stored together to avoid compiling the same pattern
// twice.  The cache is capped at MAX_PATTERN_CACHE entries; when the cap is hit
// the oldest entry (Maps preserve insertion order) is evicted before inserting,
// giving a simple O(1) LRU approximation with zero extra bookkeeping.

const MAX_PATTERN_CACHE = 512
const patternCache = new Map<string, { regex: RegExp; paramNames: string[] }>()

function getPatternEntry(pattern: string): { regex: RegExp; paramNames: string[] } {
  const existing = patternCache.get(pattern)
  if (existing) {
    // True LRU: re-insert to move this entry to the "most recently used" end.
    // Maps preserve insertion order; the first key is always the least-recently-used.
    patternCache.delete(pattern)
    patternCache.set(pattern, existing)
    return existing
  }

  // Cache miss — compile the regex and param-name list together.
  const paramNames: string[] = []
  const src = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
      paramNames.push(name)
      return '([^/]+)'
    })
  const entry = { regex: new RegExp(`^${src}$`), paramNames }

  if (patternCache.size >= MAX_PATTERN_CACHE) {
    // Evict least-recently-used (first key in insertion order).
    const lru = patternCache.keys().next().value
    if (lru !== undefined) patternCache.delete(lru)
  }
  patternCache.set(pattern, entry)
  return entry
}

/**
 * Returns true if a concrete path matches a route pattern with named params.
 * Compiled regexes are cached (LRU, max 512) by pattern string.
 *
 * pathMatchesPattern('/orders/123/live', '/orders/:userId/live') → true
 * pathMatchesPattern('/orders/123/live', '/items/:id/live')      → false
 */
export function pathMatchesPattern(concretePath: string, pattern: string): boolean {
  return getPatternEntry(pattern).regex.test(concretePath)
}

/**
 * Extract named path params from a concrete path given a route pattern.
 * Shares the same cached regex as pathMatchesPattern — one compilation per pattern.
 *
 * extractParams('/orders/123/live', '/orders/:userId/live') → { userId: '123' }
 */
export function extractParams(concretePath: string, pattern: string): Record<string, string> {
  const { regex, paramNames } = getPatternEntry(pattern)
  const match = concretePath.match(regex)
  if (!match) return {}
  return Object.fromEntries(paramNames.map((name, i) => [name, match[i + 1]!]))
}

// ── ReactiveEngine ─────────────────────────────────────────────────────────────

interface Subscription {
  clientId: string
  path: string
  ctx: Context
  pushFn: PushFn
  /** Pre-serialization fast path: WS transport provides this to avoid N × JSON.stringify */
  pushSerializedFn?: (serialized: string) => void
}

/**
 * Core reactive engine.
 *
 * Responsibilities:
 * 1. Holds the registry of @Reactive endpoints
 * 2. Subscribes to the DatabaseAdapter for each watched table
 * 3. On a ChangeEvent, fans out to matching subscribers after applying filters
 * 4. Supports optional per-subscriber debouncing
 *
 * ## Fan-out optimisation
 * Subscribers watching the same concrete path (e.g. `/posts/live`) share a
 * single handler invocation per ChangeEvent.  The handler is called **once**
 * per unique concrete path and the result is pushed to every subscriber in
 * that group — avoiding N DB queries for N connected clients.
 *
 * ## O(1) event routing
 * Two reverse indexes eliminate per-event iteration of all subscribers:
 *
 * • `tableToEndpoints`  — table name → endpoints that watch it.
 *   `onChangeEvent` skips all endpoints that don't watch the changed table.
 *
 * • `subscriptionsByEndpoint` — endpointPattern → concretePath → Set<clientId>.
 *   Built on `subscribe()`, maintained on `unsubscribe()`.  On a ChangeEvent the
 *   engine looks up matching subscriber groups in O(1) instead of regex-testing
 *   every active subscription.
 *
 * ### Why this matters for chat / room-scoped apps
 * 50,000 subscriptions across 1,000 rooms (50 per room):
 * - Before: 50,000 regex tests to find the 50 subscribers in room 42.
 * - After:  1 map lookup → 1 set of 50 clientIds → 50 filter checks.
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
  /** table → endpoints watching it — O(1) lookup in onChangeEvent */
  private readonly tableToEndpoints = new Map<string, ReactiveEndpoint[]>()
  /**
   * Subscription reverse index: endpointPattern → concretePath → Set<clientId>.
   * Maintained on every subscribe/unsubscribe so fan-out routing is O(1).
   */
  private readonly subscriptionsByEndpoint = new Map<string, Map<string, Set<string>>>()
  /**
   * Per-client reverse pointer: clientId → [endpointPattern, concretePath] pairs.
   * Used by unsubscribe() to remove the client from subscriptionsByEndpoint in O(1).
   */
  private readonly clientEndpointPaths = new Map<string, Array<[string, string]>>()

  /** Registered adapter set — supports multiple adapters for multi-DB flows. */
  private readonly adapters = new Set<DatabaseAdapter>()

  constructor(adapter: DatabaseAdapter | null) {
    if (adapter) this.adapters.add(adapter)
  }

  /**
   * Register an additional adapter (called by flow() when a store carries ADAPTER_SYMBOL).
   * Idempotent — adding the same adapter twice is a no-op.
   */
  registerAdapter(adapter: DatabaseAdapter): void {
    if (this.adapters.has(adapter)) return
    this.adapters.add(adapter)
    // Re-wire any already-registered endpoints that reference tables on this adapter.
    for (const endpoint of this.endpoints) {
      for (const table of normalizeWatch(endpoint.options.watch)) {
        this.setupTableWatcher(table)
      }
    }
  }

  registerEndpoint(endpoint: ReactiveEndpoint): void {
    this.endpoints.push(endpoint)
    for (const table of normalizeWatch(endpoint.options.watch)) {
      this.setupTableWatcher(table)
      // Build reverse index: table → [endpoints]
      const list = this.tableToEndpoints.get(table)
      if (list) {
        list.push(endpoint)
      } else {
        this.tableToEndpoints.set(table, [endpoint])
      }
    }
  }

  subscribe(
    clientId: string,
    path: string,
    ctx: Context,
    pushFn: PushFn,
    pushSerializedFn?: (serialized: string) => void,
  ): void {
    this.subscriptions.set(clientId, { clientId, path, ctx, pushFn, pushSerializedFn })

    // Single pass over endpoints:
    // 1. Build subscription reverse index (subscriptionsByEndpoint)
    // 2. Kick off initial pushes — both share the same pathMatchesPattern test.
    const clientPairs: Array<[string, string]> = []
    for (const endpoint of this.endpoints) {
      if (!pathMatchesPattern(path, endpoint.routePath)) continue

      // ── Update reverse index ─────────────────────────────────────────────
      let groups = this.subscriptionsByEndpoint.get(endpoint.routePath)
      if (!groups) {
        groups = new Map<string, Set<string>>()
        this.subscriptionsByEndpoint.set(endpoint.routePath, groups)
      }
      let clientSet = groups.get(path)
      if (!clientSet) {
        clientSet = new Set<string>()
        groups.set(path, clientSet)
      }
      clientSet.add(clientId)
      clientPairs.push([endpoint.routePath, path])

      // ── Initial push ─────────────────────────────────────────────────────
      // Push current state immediately so the client has data without waiting
      // for the first DB change event (eliminates a separate get() + subscribe()).
      void this.initialPush(clientId, endpoint)
    }

    if (clientPairs.length > 0) {
      this.clientEndpointPaths.set(clientId, clientPairs)
    }
  }

  /**
   * Executes the initial push for a newly subscribed client.
   * Checks subscription existence both before AND after the async handler —
   * the client may unsubscribe while the handler is running.
   */
  private async initialPush(clientId: string, endpoint: ReactiveEndpoint): Promise<void> {
    const sub = this.subscriptions.get(clientId)
    if (!sub) return
    try {
      // Prefer initialHandler (e.g. limited snapshot) over the full handler.
      const fn = endpoint.initialHandler ?? endpoint.handler
      const data = await fn(sub.ctx)
      // Re-check after awaiting — unsubscribe() may have run while handler was in flight
      if (!this.subscriptions.has(clientId)) return
      sub.pushFn(sub.path, data)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[RouteFlow] Initial push error on ${sub.path}: ${message}`)
    }
  }

  unsubscribe(clientId: string): void {
    this.subscriptions.delete(clientId)

    // Remove from subscription reverse index in O(1) using the client's own pointer.
    const clientPairs = this.clientEndpointPaths.get(clientId)
    if (clientPairs) {
      for (const [pattern, path] of clientPairs) {
        const groups = this.subscriptionsByEndpoint.get(pattern)
        const clientSet = groups?.get(path)
        clientSet?.delete(clientId)
        if (clientSet?.size === 0) groups?.delete(path)
        if (groups?.size === 0) this.subscriptionsByEndpoint.delete(pattern)
      }
      this.clientEndpointPaths.delete(clientId)
    }

    // Cancel any pending debounce timers for this client.
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
    // Clear all reverse indexes and state so a reused engine starts clean.
    this.tableToEndpoints.clear()
    this.subscriptionsByEndpoint.clear()
    this.clientEndpointPaths.clear()
    this.subscriptions.clear()
    this.endpoints.length = 0
  }

  private setupTableWatcher(table: string): void {
    if (this.tableWatchers.has(table)) return
    // Subscribe to ALL registered adapters — whichever fires for this table will fan out.
    const unsubs: Array<() => void> = []
    for (const adapter of this.adapters) {
      unsubs.push(adapter.onChange(table, (e) => this.onChangeEvent(e)))
    }
    this.tableWatchers.set(table, () => unsubs.forEach(fn => fn()))
  }

  private onChangeEvent(event: ChangeEvent): void {
    // O(1) reverse-index lookup — only iterate endpoints that watch this table.
    const endpoints = this.tableToEndpoints.get(event.table)
    if (!endpoints?.length) return

    for (const endpoint of endpoints) {
      // O(1) look up the pre-grouped subscriber sets for this endpoint.
      // subscriptionsByEndpoint[pattern][concretePath] = Set<clientId>
      // Each inner Set corresponds to one fan-out group (one DB query → N pushes).
      const groups = this.subscriptionsByEndpoint.get(endpoint.routePath)
      if (!groups?.size) continue

      const debounceMs = endpoint.options.debounce

      if (debounceMs !== undefined && debounceMs > 0) {
        // Per-subscriber debounced push — timers are independent per client.
        for (const [, clientIds] of groups) {
          for (const clientId of clientIds) {
            const sub = this.subscriptions.get(clientId)
            if (!sub) continue  // removed between index update and now (benign race)
            if (!this.passesFilter(endpoint, event, sub)) continue
            this.scheduleDebounced(clientId, endpoint, sub, debounceMs)
          }
        }
      } else {
        // ── O(matching) fan-out ───────────────────────────────────────────────
        // Groups are pre-built: iterate only the subscribers on this endpoint.
        // Each inner Map entry is one concrete path → share one handler call.
        //
        //   Before: O(N_total) regex tests → O(K_matching) filter checks
        //   After:  O(1) map lookup       → O(K_matching) filter checks
        //
        //   Chat app, 50k subscribers, 1k rooms:
        //   message in room 42 → look up 50 subscribers, not 50,000.
        for (const [, clientIds] of groups) {
          const subs: Subscription[] = []
          for (const clientId of clientIds) {
            const sub = this.subscriptions.get(clientId)
            if (!sub) continue  // removed between index update and now (benign race)
            if (!this.passesFilter(endpoint, event, sub)) continue
            subs.push(sub)
          }
          if (subs.length > 0) void this.executeFanOut(endpoint, event, subs)
        }
      }
    }
  }

  /**
   * Execute the handler once and push the result to every subscriber in the
   * group.  If the endpoint provides a `deltaFn`, use that instead of calling
   * the full handler (zero DB round-trip for simple INSERT/UPDATE/DELETE).
   */
  private async executeFanOut(
    endpoint: ReactiveEndpoint,
    event: ChangeEvent,
    subs: Subscription[],
  ): Promise<void> {
    if (subs.length === 0) return
    const sub = subs[0]!
    try {
      // If the endpoint exposes a fast-path delta function, use it so we skip
      // the DB re-query entirely.  Falls back to the full handler otherwise.
      const data = endpoint.deltaFn
        ? endpoint.deltaFn(event)
        : await endpoint.handler(sub.ctx)

      let hasConnected = false
      let allHaveFastPath = true
      for (const s of subs) {
        if (!this.subscriptions.has(s.clientId)) continue
        hasConnected = true
        if (!s.pushSerializedFn) {
          allHaveFastPath = false
          break
        }
      }
      if (!hasConnected) return

      // ── WS pre-serialization optimisation ──────────────────────────────────
      // All subscribers in this group share the same path (that's how they were
      // grouped), so the WS message is byte-for-byte identical for all of them.
      // When every subscriber provides a pushSerializedFn, we JSON-stringify
      // once and hand the pre-built string to each WS socket directly — saving
      // N−1 serialize calls for N connected clients.
      if (allHaveFastPath) {
        const serialized = JSON.stringify({ type: 'update', path: sub.path, data })
        for (const s of subs) {
          if (!this.subscriptions.has(s.clientId)) continue
          s.pushSerializedFn!(serialized)
        }
      } else {
        for (const s of subs) {
          if (!this.subscriptions.has(s.clientId)) continue
          s.pushFn(s.path, data)
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[RouteFlow] Reactive handler error on ${sub.path}: ${message}`)
    }
  }

  private scheduleDebounced(
    clientId: string,
    endpoint: ReactiveEndpoint,
    sub: Subscription,
    debounceMs: number,
  ): void {
    const timerKey = `${clientId}:${sub.path}`
    const existing = this.debounceTimers.get(timerKey)
    if (existing !== undefined) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.debounceTimers.delete(timerKey)
      this.clientTimers.get(clientId)?.delete(timerKey)
      void this.executeSingle(endpoint, sub)
    }, debounceMs)

    this.debounceTimers.set(timerKey, timer)
    if (!this.clientTimers.has(clientId)) this.clientTimers.set(clientId, new Set())
    this.clientTimers.get(clientId)!.add(timerKey)
  }

  private async executeSingle(endpoint: ReactiveEndpoint, sub: Subscription): Promise<void> {
    try {
      const data = await endpoint.handler(sub.ctx)
      if (this.subscriptions.has(sub.clientId)) {
        sub.pushFn(sub.path, data)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[RouteFlow] Reactive handler error on ${sub.path}: ${message}`)
    }
  }

  /** Returns false if the endpoint's filter rejects this event for this subscriber. */
  private passesFilter(endpoint: ReactiveEndpoint, event: ChangeEvent, sub: Subscription): boolean {
    if (!endpoint.options.filter) return true
    try {
      return endpoint.options.filter(event, sub.ctx)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[RouteFlow] Filter error on ${endpoint.routePath} for client ${sub.clientId}: ${message}`,
      )
      return false
    }
  }
}

/** Normalise `watch` to a guaranteed string array. */
function normalizeWatch(watch: string | string[]): string[] {
  return Array.isArray(watch) ? watch : [watch]
}
