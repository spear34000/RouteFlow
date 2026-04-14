/**
 * Tests for:
 *  1. Fan-out optimisation   — N subscribers → handler called ONCE per path group
 *  2. Delta push mode        — flow({ push: 'delta' }) sends changed row, not full list
 *  3. PATCH support          — flow() registers both PUT and PATCH
 *  4. Redis adapter          — handleMessage error-handling (no uncaught throw)
 *  5. Board/Chat patterns    — multi-table flow() and snapshot vs delta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp } from './index.js'
import { MemoryAdapter } from './core/adapter/memory-adapter.js'
import { ReactiveEngine } from './core/reactive/engine.js'
import type { TableStore, ChangeEvent } from './core/types.js'

// ── Minimal in-memory TableStore ──────────────────────────────────────────────

interface Row { id: number; name: string }

function makeStore(initial: Row[] = []): TableStore<Row> {
  let seq = initial.length
  const rows: Row[] = [...initial]
  return {
    list:   async ()      => [...rows],
    get:    async (id)    => rows.find(r => r.id === id) ?? null,
    create: async (data)  => { const r = { id: ++seq, ...data } as Row; rows.push(r); return r },
    update: async (id, d) => {
      const i = rows.findIndex(r => r.id === id)
      if (i === -1) return null
      rows[i] = { ...rows[i]!, ...d }
      return rows[i]!
    },
    delete: async (id) => {
      const i = rows.findIndex(r => r.id === id)
      if (i === -1) return false
      rows.splice(i, 1); return true
    },
  }
}

// ── Helper: start app, return baseUrl ─────────────────────────────────────────

async function startApp(setup: (app: ReturnType<typeof createApp>) => void) {
  const adapter = new MemoryAdapter()
  const app     = createApp({ adapter, port: 0 })
  setup(app)
  await app.listen()
  const address = app.getFastify().server.address()
  const port    = typeof address === 'object' && address ? address.port : 3000
  return { app, baseUrl: `http://127.0.0.1:${port}`, adapter }
}

// ── 1. Fan-out: handler called ONCE per event, not per subscriber ─────────────

describe('ReactiveEngine fan-out', () => {
  let engine: ReactiveEngine
  let adapter: MemoryAdapter

  beforeEach(() => {
    adapter = new MemoryAdapter()
    engine  = new ReactiveEngine(adapter)
  })

  afterEach(() => {
    engine.destroy()
  })

  it('calls the handler exactly once when multiple subscribers watch the same path', async () => {
    let handlerCalls = 0
    const handler = vi.fn(async () => { handlerCalls++; return [{ id: 1, name: 'x' }] })

    engine.registerEndpoint({
      routePath: '/items/live',
      options:   { watch: 'items' },
      handler,
    })

    const pushes: unknown[] = []
    const pushFn = (_path: string, data: unknown) => pushes.push(data)
    const ctx = { params: {}, query: {}, body: undefined, headers: {} }

    // Subscribe 5 clients to the same path
    for (let i = 0; i < 5; i++) {
      engine.subscribe(`client-${i}`, '/items/live', ctx, pushFn)
    }

    // Wait for initial pushes (one per client, 5 handler calls expected here)
    await new Promise(r => setTimeout(r, 30))
    const initialCalls = handlerCalls

    // Reset counter for the change-event phase
    handlerCalls = 0
    handler.mockClear()

    // Fire one change event
    adapter.emit('items', { operation: 'INSERT', newRow: { id: 2, name: 'y' }, oldRow: null })
    await new Promise(r => setTimeout(r, 30))

    // Handler must have been called exactly ONCE for the single change event,
    // regardless of how many clients are subscribed.
    expect(handlerCalls).toBe(1)
    // All 5 clients should have received the push
    expect(pushes.length).toBe(initialCalls + 5)
  })

  it('uses deltaFn when provided (zero handler calls on change event)', async () => {
    const handler = vi.fn(async () => [{ id: 1, name: 'x' }])
    const deltaFn = vi.fn((e: ChangeEvent) => ({ operation: e.operation, row: e.newRow }))

    engine.registerEndpoint({
      routePath: '/messages/live',
      options:   { watch: 'messages' },
      handler,
      deltaFn,
    })

    const pushes: unknown[] = []
    const ctx = { params: {}, query: {}, body: undefined, headers: {} }
    engine.subscribe('c1', '/messages/live', ctx, (_p, d) => pushes.push(d))

    // Wait for initial push (uses handler, not deltaFn)
    await new Promise(r => setTimeout(r, 30))
    handler.mockClear()

    // Fire change — should use deltaFn, not handler
    adapter.emit('messages', { operation: 'INSERT', newRow: { id: 2, content: 'hi' }, oldRow: null })
    await new Promise(r => setTimeout(r, 30))

    expect(deltaFn).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalled()

    const delta = pushes[pushes.length - 1] as { operation: string; row: unknown }
    expect(delta.operation).toBe('INSERT')
    expect((delta.row as { id: number }).id).toBe(2)
  })
})

// ── 2. flow() PATCH support ───────────────────────────────────────────────────

describe('flow() PATCH support', () => {
  it('registers PATCH alongside PUT', async () => {
    const store = makeStore([{ id: 1, name: 'original' }])
    const { app, baseUrl } = await startApp(a => a.flow('/items', store))

    try {
      const patchRes = await fetch(`${baseUrl}/items/1`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: 'patched' }),
      })
      expect(patchRes.status).toBe(200)
      const patched = await patchRes.json() as Row
      expect(patched.name).toBe('patched')

      const putRes = await fetch(`${baseUrl}/items/1`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: 'replaced' }),
      })
      expect(putRes.status).toBe(200)
      const replaced = await putRes.json() as Row
      expect(replaced.name).toBe('replaced')
    } finally {
      await app.close()
    }
  })
})

// ── 3. flow() delta push mode ─────────────────────────────────────────────────

describe('flow() delta push mode', () => {
  it('push:delta — GET /live still serves HTTP snapshot', async () => {
    const store = makeStore([{ id: 1, name: 'a' }])
    const { app, baseUrl } = await startApp(a =>
      a.flow('/messages', store, { push: 'delta' }),
    )
    try {
      const res = await fetch(`${baseUrl}/messages/live`)
      expect(res.status).toBe(200)
      const data = await res.json() as Row[]
      expect(data).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('push:snapshot — GET /live returns full list', async () => {
    const store = makeStore([{ id: 1, name: 'a' }])
    const { app, baseUrl } = await startApp(a =>
      a.flow('/items', store, { push: 'snapshot' }),
    )
    try {
      const res  = await fetch(`${baseUrl}/items/live`)
      expect(res.status).toBe(200)
      const data = await res.json() as Row[]
      expect(data).toHaveLength(1)
    } finally {
      await app.close()
    }
  })
})

// ── 4. Redis adapter — no uncaught throw on bad payload ───────────────────────

describe('RedisAdapter error handling', () => {
  it('does not throw on invalid JSON — calls onError instead', async () => {
    const { RedisAdapter } = await import('./adapters/redis/redis-adapter.js')

    const errors: Error[] = []
    let messageCb: ((channel: string, payload: string) => void) | null = null

    const mockSubscriber = {
      subscribe:   vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      on: (event: string, cb: (...a: unknown[]) => void) => {
        if (event === 'message') messageCb = cb as (c: string, p: string) => void
      },
      off: vi.fn(),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new RedisAdapter({ subscriber: mockSubscriber as any, channelPrefix: 'test', onError: (e) => errors.push(e as Error) })
    await adapter.connect()

    expect(() => messageCb!('test:items', '{ bad json')).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toMatch(/parse/i)
  })

  it('does not throw on oversized payload — calls onError instead', async () => {
    const { RedisAdapter } = await import('./adapters/redis/redis-adapter.js')

    const errors: Error[] = []
    let messageCb: ((channel: string, payload: string) => void) | null = null

    const mockSubscriber = {
      subscribe:   vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      on: (event: string, cb: (...a: unknown[]) => void) => {
        if (event === 'message') messageCb = cb as (c: string, p: string) => void
      },
      off: vi.fn(),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new RedisAdapter({ subscriber: mockSubscriber as any, channelPrefix: 'test', onError: (e) => errors.push(e as Error) })
    await adapter.connect()

    // Payload larger than 1 MiB
    expect(() => messageCb!('test:items', 'x'.repeat(1_100_000))).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toMatch(/oversized/i)
  })
})

// ── 5. Board/Chat multi-table flow() ─────────────────────────────────────────

describe('Board pattern — multi-table flow()', () => {
  it('serves posts and comments as independent endpoints', async () => {
    const posts    = makeStore([{ id: 1, name: 'First post' }])
    const comments = makeStore([{ id: 1, name: 'First comment' }])
    const { app, baseUrl } = await startApp(a =>
      a.flow('/posts', posts).flow('/comments', comments),
    )
    try {
      const [pRes, cRes] = await Promise.all([
        fetch(`${baseUrl}/posts`),
        fetch(`${baseUrl}/comments`),
      ])
      expect(pRes.status).toBe(200)
      expect(cRes.status).toBe(200)
      const pData = await pRes.json() as Row[]
      const cData = await cRes.json() as Row[]
      expect(pData[0]!.name).toBe('First post')
      expect(cData[0]!.name).toBe('First comment')
    } finally {
      await app.close()
    }
  })

  it('posts /live and /comments/live are independent reactive endpoints', async () => {
    const posts    = makeStore([])
    const comments = makeStore([])
    const { app, baseUrl } = await startApp(a =>
      a.flow('/posts', posts).flow('/comments', comments),
    )
    try {
      const [pLive, cLive] = await Promise.all([
        fetch(`${baseUrl}/posts/live`),
        fetch(`${baseUrl}/comments/live`),
      ])
      expect(pLive.status).toBe(200)
      expect(cLive.status).toBe(200)
    } finally {
      await app.close()
    }
  })
})

describe('Chat pattern — delta push + create', () => {
  it('flow() with push:delta + create returns the created row', async () => {
    const messages = makeStore([])
    const { app, baseUrl } = await startApp(a =>
      a.flow('/messages', messages, { push: 'delta', only: ['list', 'create', 'live'] }),
    )
    try {
      const res = await fetch(`${baseUrl}/messages`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: 'hello world' }),
      })
      expect(res.status).toBe(200)
      const row = await res.json() as Row
      expect(row.name).toBe('hello world')
      expect(typeof row.id).toBe('number')
    } finally {
      await app.close()
    }
  })

  it('delta mode: PATCH is not registered when update not in only[]', async () => {
    const messages = makeStore([{ id: 1, name: 'x' }])
    const { app, baseUrl } = await startApp(a =>
      a.flow('/messages', messages, { only: ['list', 'create', 'live'] }),
    )
    try {
      const res = await fetch(`${baseUrl}/messages/1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"name":"y"}' })
      // 404 or 405 expected (route not registered)
      expect(res.status === 404 || res.status === 405).toBe(true)
    } finally {
      await app.close()
    }
  })
})
