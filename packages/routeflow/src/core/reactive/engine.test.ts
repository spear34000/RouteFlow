import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReactiveEngine, pathMatchesPattern, extractParams } from './engine.js'
import { MemoryAdapter } from '../adapter/memory-adapter.js'
import type { Context } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(params: Record<string, string> = {}): Context {
  return { params, query: {}, body: undefined, headers: {} }
}

// ---------------------------------------------------------------------------
// pathMatchesPattern
// ---------------------------------------------------------------------------

describe('pathMatchesPattern', () => {
  it('matches exact path with no params', () => {
    expect(pathMatchesPattern('/items', '/items')).toBe(true)
  })

  it('matches path with a single named param', () => {
    expect(pathMatchesPattern('/orders/123/live', '/orders/:userId/live')).toBe(true)
  })

  it('matches path with multiple named params', () => {
    expect(pathMatchesPattern('/a/1/b/2', '/a/:x/b/:y')).toBe(true)
  })

  it('does not match different path', () => {
    expect(pathMatchesPattern('/orders/123/live', '/items/:id/live')).toBe(false)
  })

  it('does not match partial path', () => {
    expect(pathMatchesPattern('/orders/123', '/orders/:userId/live')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// extractParams
// ---------------------------------------------------------------------------

describe('extractParams', () => {
  it('extracts a single param', () => {
    expect(extractParams('/orders/42/live', '/orders/:userId/live')).toEqual({ userId: '42' })
  })

  it('extracts multiple params', () => {
    expect(extractParams('/a/foo/b/bar', '/a/:x/b/:y')).toEqual({ x: 'foo', y: 'bar' })
  })

  it('returns empty object for no match', () => {
    expect(extractParams('/other', '/orders/:id')).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// MemoryAdapter
// ---------------------------------------------------------------------------

describe('MemoryAdapter', () => {
  it('calls listener when emit is called', () => {
    const adapter = new MemoryAdapter()
    const cb = vi.fn()

    adapter.onChange('orders', cb)
    adapter.emit('orders', { operation: 'INSERT', newRow: { id: 1 }, oldRow: null })

    expect(cb).toHaveBeenCalledOnce()
    expect(cb.mock.calls[0][0]).toMatchObject({
      table: 'orders',
      operation: 'INSERT',
      newRow: { id: 1 },
      oldRow: null,
    })
  })

  it('does not call listener after unsubscribe', () => {
    const adapter = new MemoryAdapter()
    const cb = vi.fn()

    const unsub = adapter.onChange('orders', cb)
    unsub()
    adapter.emit('orders', { operation: 'INSERT', newRow: { id: 1 }, oldRow: null })

    expect(cb).not.toHaveBeenCalled()
  })

  it('does not call listeners on a different table', () => {
    const adapter = new MemoryAdapter()
    const cb = vi.fn()

    adapter.onChange('users', cb)
    adapter.emit('orders', { operation: 'INSERT', newRow: {}, oldRow: null })

    expect(cb).not.toHaveBeenCalled()
  })

  it('reports isConnected correctly', async () => {
    const adapter = new MemoryAdapter()
    expect(adapter.isConnected).toBe(false)
    await adapter.connect()
    expect(adapter.isConnected).toBe(true)
    await adapter.disconnect()
    expect(adapter.isConnected).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Decorators
// ---------------------------------------------------------------------------

describe('Decorators', () => {
  it('@Route stores metadata on the method', async () => {
    const { Route, routeFnStore } = await import('../decorator/route.js')

    class Controller {
      @Route('GET', '/test/:id')
      async handler(_ctx: Context) {
        return {}
      }
    }

    // WeakMap-based lookup — compatible with both TC39 and legacy decorators
    const meta = routeFnStore.get(Controller.prototype.handler as object)
    expect(meta).toEqual({ method: 'GET', path: '/test/:id' })
  })

  it('@Reactive stores metadata on the method', async () => {
    const { Reactive, reactiveFnStore } = await import('../decorator/reactive.js')

    class Controller {
      @Reactive({ watch: 'items', debounce: 50 })
      async handler(_ctx: Context) {
        return {}
      }
    }

    const meta = reactiveFnStore.get(Controller.prototype.handler as object)
    expect(meta).toEqual({ watch: 'items', debounce: 50 })
  })
})

// ---------------------------------------------------------------------------
// ReactiveEngine
// ---------------------------------------------------------------------------

describe('ReactiveEngine', () => {
  let adapter: MemoryAdapter
  let engine: ReactiveEngine

  beforeEach(() => {
    adapter = new MemoryAdapter()
    engine = new ReactiveEngine(adapter)
  })

  it('pushes to subscriber when DB changes', async () => {
    const pushed = vi.fn()

    engine.registerEndpoint({
      routePath: '/items/live',
      options: { watch: 'items' },
      handler: async (_ctx) => [{ id: 1 }],
    })

    engine.subscribe('client-1', '/items/live', makeCtx(), pushed)

    adapter.emit('items', { operation: 'INSERT', newRow: { id: 2 }, oldRow: null })

    // Handler is async — wait a microtask tick.
    // subscribe() fires an immediate initial push + one push for the DB change.
    await Promise.resolve()

    expect(pushed).toHaveBeenCalledTimes(2)
    expect(pushed).toHaveBeenCalledWith('/items/live', [{ id: 1 }])
  })

  it('does not push to subscriber after unsubscribe', async () => {
    const pushed = vi.fn()

    engine.registerEndpoint({
      routePath: '/items/live',
      options: { watch: 'items' },
      handler: async () => [],
    })

    // Unsubscribe immediately — the initial push guard skips it
    engine.subscribe('client-1', '/items/live', makeCtx(), pushed)
    engine.unsubscribe('client-1')

    adapter.emit('items', { operation: 'INSERT', newRow: { id: 1 }, oldRow: null })
    await Promise.resolve()

    expect(pushed).not.toHaveBeenCalled()
  })

  it('removes empty reverse-index groups on unsubscribe', async () => {
    const pushed = vi.fn()

    engine.registerEndpoint({
      routePath: '/items/live',
      options: { watch: 'items' },
      handler: async () => [],
    })

    engine.subscribe('client-1', '/items/live', makeCtx(), pushed)
    engine.unsubscribe('client-1')

    const internal = engine as unknown as {
      subscriptionsByEndpoint: Map<string, Map<string, Set<string>>>
      clientEndpointPaths: Map<string, Array<[string, string]>>
    }

    expect(internal.clientEndpointPaths.size).toBe(0)
    expect(internal.subscriptionsByEndpoint.size).toBe(0)
  })

  it('uses pre-serialized fast path once per fan-out group', async () => {
    const pushSerialized1 = vi.fn()
    const pushSerialized2 = vi.fn()
    const push1 = vi.fn()
    const push2 = vi.fn()

    engine.registerEndpoint({
      routePath: '/items/live',
      options: { watch: 'items' },
      handler: async () => [{ id: 1 }],
    })

    engine.subscribe('client-1', '/items/live', makeCtx(), push1, pushSerialized1)
    engine.subscribe('client-2', '/items/live', makeCtx(), push2, pushSerialized2)
    await Promise.resolve()
    pushSerialized1.mockClear()
    pushSerialized2.mockClear()
    push1.mockClear()
    push2.mockClear()

    adapter.emit('items', { operation: 'INSERT', newRow: { id: 1 }, oldRow: null })
    await Promise.resolve()

    expect(pushSerialized1).toHaveBeenCalledOnce()
    expect(pushSerialized2).toHaveBeenCalledOnce()
    expect(push1).not.toHaveBeenCalled()
    expect(push2).not.toHaveBeenCalled()
    expect(pushSerialized1.mock.calls[0]?.[0]).toBe(pushSerialized2.mock.calls[0]?.[0])
  })

  it('applies filter — pushes only to matching subscribers', async () => {
    const pushedUser1 = vi.fn()
    const pushedUser2 = vi.fn()

    engine.registerEndpoint({
      routePath: '/orders/:userId/live',
      options: {
        watch: 'orders',
        filter: (event, ctx) => {
          const row = event.newRow as Record<string, unknown> | null
          return row?.['userId'] === ctx.params['userId']
        },
      },
      handler: async (ctx) => [{ userId: ctx.params['userId'] }],
    })

    engine.subscribe('client-1', '/orders/alice/live', makeCtx({ userId: 'alice' }), pushedUser1)
    engine.subscribe('client-2', '/orders/bob/live', makeCtx({ userId: 'bob' }), pushedUser2)

    // Only alice's row triggers the filter; but both got an initial push on subscribe
    adapter.emit('orders', { operation: 'INSERT', newRow: { userId: 'alice', item: 'book' }, oldRow: null })
    await Promise.resolve()

    // alice: 1 initial push + 1 DB-change push (filter passes)
    expect(pushedUser1).toHaveBeenCalledTimes(2)
    // bob: 1 initial push only (DB-change filtered out)
    expect(pushedUser2).toHaveBeenCalledTimes(1)
  })

  it('watches multiple tables (watch: string[])', async () => {
    const pushed = vi.fn()

    engine.registerEndpoint({
      routePath: '/feed/live',
      options: { watch: ['posts', 'comments'] },
      handler: async () => ['feed-item'],
    })

    engine.subscribe('client-1', '/feed/live', makeCtx(), pushed)

    // 1 initial push + 1 posts emit = 2
    adapter.emit('posts', { operation: 'INSERT', newRow: { id: 1 }, oldRow: null })
    await Promise.resolve()
    expect(pushed).toHaveBeenCalledTimes(2)

    // + 1 comments emit = 3
    adapter.emit('comments', { operation: 'INSERT', newRow: { id: 2 }, oldRow: null })
    await Promise.resolve()
    expect(pushed).toHaveBeenCalledTimes(3)
  })

  it('debounces rapid changes and pushes only once', async () => {
    vi.useFakeTimers()
    const pushed = vi.fn()

    engine.registerEndpoint({
      routePath: '/items/live',
      options: { watch: 'items', debounce: 100 },
      handler: async () => ['latest'],
    })

    engine.subscribe('client-1', '/items/live', makeCtx(), pushed)

    adapter.emit('items', { operation: 'INSERT', newRow: { id: 1 }, oldRow: null })
    adapter.emit('items', { operation: 'INSERT', newRow: { id: 2 }, oldRow: null })
    adapter.emit('items', { operation: 'INSERT', newRow: { id: 3 }, oldRow: null })

    // Debounce window hasn't elapsed yet; initial push is also not yet resolved
    // (it's behind an async handler — pending microtask)
    expect(pushed).not.toHaveBeenCalled()

    vi.advanceTimersByTime(150)
    await Promise.resolve()

    // 1 initial push (from subscribe) + 1 debounced push (3 emits collapsed)
    expect(pushed).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('keeps query-distinct subscriptions separate when no groupKeyFn is provided', async () => {
    const pushedOpen = vi.fn()
    const pushedClosed = vi.fn()

    engine.registerEndpoint({
      routePath: '/items/live',
      options: { watch: 'items' },
      handler: async (ctx) => [{ status: ctx.query['status'] }],
    })

    engine.subscribe(
      'client-open',
      '/items/live?status=open',
      { ...makeCtx(), query: { status: 'open' } },
      pushedOpen,
    )
    engine.subscribe(
      'client-closed',
      '/items/live?status=closed',
      { ...makeCtx(), query: { status: 'closed' } },
      pushedClosed,
    )

    await Promise.resolve()
    pushedOpen.mockClear()
    pushedClosed.mockClear()

    adapter.emit('items', { operation: 'INSERT', newRow: { id: 1 }, oldRow: null })
    await Promise.resolve()

    expect(pushedOpen).toHaveBeenCalledWith('/items/live?status=open', [{ status: 'open' }])
    expect(pushedClosed).toHaveBeenCalledWith('/items/live?status=closed', [{ status: 'closed' }])
  })
})
