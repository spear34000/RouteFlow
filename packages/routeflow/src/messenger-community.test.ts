/**
 * v1.0.17 feature tests — messenger & community patterns
 *
 * Covers:
 *  1. queryFilter   — room-scoped list (WHERE roomId = ?)
 *  2. createMerge   — path param auto-stamped onto created row
 *  3. initialLimit  — initial subscription push is capped
 *  4. query:'auto'  — ?limit / ?offset / ?after / ?orderBy / ?order
 *  5. Cursor pagination (after) — keyset pagination via store.list()
 *  6. Derived reactive filter   — queryFilter auto-derives WS push filter
 *  7. Presence hooks            — onConnect / onDisconnect called on WS connect/close
 *  8. Delta push filter         — only matching room rows are pushed to a subscriber
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp } from './index.js'
import { MemoryAdapter } from './core/adapter/memory-adapter.js'
import type { TableStore, StoreListOptions, ChangeEvent } from './core/types.js'

// ── In-memory store that records list() calls ────────────────────────────────

interface Message { id: number; roomId: number; content: string }

function makeMessageStore(initial: Message[] = []): TableStore<Message> & {
  listCalls: StoreListOptions<Message>[]
} {
  let seq = initial.length
  const rows: Message[] = [...initial]
  const listCalls: StoreListOptions<Message>[] = []

  return {
    listCalls,
    list: async (opts?: StoreListOptions<Message>) => {
      listCalls.push(opts ?? {})
      let result = [...rows]
      if (opts?.where) {
        const where = opts.where as Partial<Message>
        result = result.filter(r =>
          Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
        )
      }
      if (opts?.after != null) result = result.filter(r => r.id > opts.after!)
      if (opts?.limit  != null) result = result.slice(0, opts.limit)
      return result
    },
    get:    async (id)    => rows.find(r => r.id === id) ?? null,
    create: async (data)  => { const r = { id: ++seq, ...data } as Message; rows.push(r); return r },
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

// ── Start helper ─────────────────────────────────────────────────────────────

async function startApp(setup: (app: ReturnType<typeof createApp>) => void, appOptions?: Parameters<typeof createApp>[0]) {
  const adapter = new MemoryAdapter()
  const app = createApp({ adapter, port: 0, ...appOptions })
  setup(app)
  await app.listen()
  const address = app.getFastify().server.address()
  const port = typeof address === 'object' && address ? address.port : 3000
  return { app, baseUrl: `http://127.0.0.1:${port}`, adapter }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. queryFilter — room-scoped list
// ─────────────────────────────────────────────────────────────────────────────

describe('queryFilter — room-scoped messages', () => {
  it('GET /rooms/:roomId/messages passes WHERE roomId to store.list()', async () => {
    const store = makeMessageStore([
      { id: 1, roomId: 1, content: 'hello room 1' },
      { id: 2, roomId: 2, content: 'hello room 2' },
      { id: 3, roomId: 1, content: 'hello room 1 again' },
    ])
    const { app, baseUrl } = await startApp((a) => {
      a.flow('/rooms/:roomId/messages', store, {
        queryFilter: (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
      })
    })
    try {
      const res = await fetch(`${baseUrl}/rooms/1/messages`)
      expect(res.status).toBe(200)
      const data = await res.json() as Message[]
      expect(data).toHaveLength(2)
      expect(data.every(m => m.roomId === 1)).toBe(true)

      // Verify store.list() was called with correct WHERE
      expect(store.listCalls.at(-1)).toMatchObject({ where: { roomId: 1 } })
    } finally {
      await app.close()
    }
  })

  it('GET /rooms/2/messages only returns room 2 messages', async () => {
    const store = makeMessageStore([
      { id: 1, roomId: 1, content: 'room 1' },
      { id: 2, roomId: 2, content: 'room 2' },
    ])
    const { app, baseUrl } = await startApp((a) => {
      a.flow('/rooms/:roomId/messages', store, {
        queryFilter: (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
      })
    })
    try {
      const res = await fetch(`${baseUrl}/rooms/2/messages`)
      const data = await res.json() as Message[]
      expect(data).toHaveLength(1)
      expect(data[0]!.content).toBe('room 2')
    } finally {
      await app.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. createMerge — path param auto-stamped onto created row
// ─────────────────────────────────────────────────────────────────────────────

describe('createMerge — auto-stamp path params on create', () => {
  it('POST /rooms/:roomId/messages stamps roomId into the created row', async () => {
    const store = makeMessageStore()
    const { app, baseUrl } = await startApp((a) => {
      a.flow('/rooms/:roomId/messages', store, {
        queryFilter:  (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
        // createMerge defaults to queryFilter result — should stamp roomId:42
      })
    })
    try {
      const res = await fetch(`${baseUrl}/rooms/42/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hi from room 42' }),
      })
      expect(res.status).toBe(200)
      const created = await res.json() as Message
      expect(created.roomId).toBe(42)
      expect(created.content).toBe('hi from room 42')
    } finally {
      await app.close()
    }
  })

  it('explicit createMerge overrides the queryFilter merge', async () => {
    const store = makeMessageStore()
    const { app, baseUrl } = await startApp((a) => {
      a.flow('/rooms/:roomId/messages', store, {
        queryFilter:  (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
        createMerge:  (ctx) => ({ roomId: Number(ctx.params['roomId']), source: 'web' }),
      })
    })
    try {
      const res = await fetch(`${baseUrl}/rooms/7/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'test' }),
      })
      const created = await res.json() as Message & { source: string }
      expect(created.roomId).toBe(7)
      expect(created.source).toBe('web')
    } finally {
      await app.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. query:'auto' — URL query params mapped to list options
// ─────────────────────────────────────────────────────────────────────────────

describe("query:'auto' — URL query params", () => {
  it('?limit=2 is forwarded to store.list()', async () => {
    const store = makeMessageStore([
      { id: 1, roomId: 1, content: 'a' },
      { id: 2, roomId: 1, content: 'b' },
      { id: 3, roomId: 1, content: 'c' },
    ])
    const { app, baseUrl } = await startApp((a) => {
      a.flow('/messages', store, { query: 'auto' })
    })
    try {
      const res = await fetch(`${baseUrl}/messages?limit=2`)
      const data = await res.json() as Message[]
      expect(data).toHaveLength(2)
      expect(store.listCalls.at(-1)).toMatchObject({ limit: 2 })
    } finally {
      await app.close()
    }
  })

  it('?after=2 returns only rows with id > 2', async () => {
    const store = makeMessageStore([
      { id: 1, roomId: 1, content: 'a' },
      { id: 2, roomId: 1, content: 'b' },
      { id: 3, roomId: 1, content: 'c' },
      { id: 4, roomId: 1, content: 'd' },
    ])
    const { app, baseUrl } = await startApp((a) => {
      a.flow('/messages', store, { query: 'auto' })
    })
    try {
      const res = await fetch(`${baseUrl}/messages?after=2`)
      const data = await res.json() as Message[]
      expect(data.every(m => m.id > 2)).toBe(true)
      expect(store.listCalls.at(-1)).toMatchObject({ after: 2 })
    } finally {
      await app.close()
    }
  })

  it('?limit, ?after and ?order all combined', async () => {
    const store = makeMessageStore([
      { id: 1, roomId: 1, content: 'a' },
      { id: 2, roomId: 1, content: 'b' },
      { id: 3, roomId: 1, content: 'c' },
    ])
    const { app, baseUrl } = await startApp((a) => {
      a.flow('/messages', store, { query: 'auto' })
    })
    try {
      await fetch(`${baseUrl}/messages?limit=5&after=0&order=desc`)
      const call = store.listCalls.at(-1)!
      expect(call.limit).toBe(5)
      expect(call.after).toBe(0)
      expect(call.order).toBe('desc')
    } finally {
      await app.close()
    }
  })

  it('?limit is capped at 10_000', async () => {
    const store = makeMessageStore()
    const { app, baseUrl } = await startApp((a) => {
      a.flow('/messages', store, { query: 'auto' })
    })
    try {
      await fetch(`${baseUrl}/messages?limit=999999`)
      expect(store.listCalls.at(-1)).toMatchObject({ limit: 10_000 })
    } finally {
      await app.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cursor pagination via store.list()
// ─────────────────────────────────────────────────────────────────────────────

describe('cursor pagination (after)', () => {
  it('after:N skips all rows with id <= N', async () => {
    const store = makeMessageStore([
      { id: 1, roomId: 1, content: 'msg1' },
      { id: 2, roomId: 1, content: 'msg2' },
      { id: 3, roomId: 1, content: 'msg3' },
      { id: 4, roomId: 1, content: 'msg4' },
    ])
    const rows = await store.list({ after: 2 })
    expect(rows.map(r => r.id)).toEqual([3, 4])
  })

  it('after:0 returns all rows (equivalent to no cursor)', async () => {
    const store = makeMessageStore([
      { id: 1, roomId: 1, content: 'msg1' },
      { id: 2, roomId: 1, content: 'msg2' },
    ])
    const rows = await store.list({ after: 0 })
    expect(rows).toHaveLength(2)
  })

  it('after + limit implements load-more pagination', async () => {
    const store = makeMessageStore(
      Array.from({ length: 10 }, (_, i) => ({ id: i + 1, roomId: 1, content: `msg${i + 1}` })),
    )
    const page1 = await store.list({ limit: 3, after: 0 })
    expect(page1.map(r => r.id)).toEqual([1, 2, 3])

    const page2 = await store.list({ limit: 3, after: page1.at(-1)!.id })
    expect(page2.map(r => r.id)).toEqual([4, 5, 6])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. initialLimit — cap initial subscription push
// ─────────────────────────────────────────────────────────────────────────────

describe('initialLimit — capped initial reactive push', () => {
  it('store.list() called with { limit: N, order: desc } on first subscribe', async () => {
    const store = makeMessageStore(
      Array.from({ length: 20 }, (_, i) => ({ id: i + 1, roomId: 1, content: `msg${i + 1}` })),
    )
    const adapter = new MemoryAdapter()
    const app = createApp({ adapter, port: 0 })
    app.flow('/messages', store, { initialLimit: 5 })
    await app.listen()
    const address = app.getFastify().server.address()
    const port = typeof address === 'object' && address ? address.port : 3000

    try {
      // Subscribe via WebSocket and collect the first push
      const { WebSocket } = await import('ws')
      const received: unknown[] = []
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', path: '/messages/live' })))
        ws.on('message', (raw: Buffer) => {
          const msg = JSON.parse(raw.toString()) as { type: string; data: unknown }
          if (msg.type === 'update') {
            received.push(msg.data)
            ws.close()
          }
        })
        ws.on('close', resolve)
        ws.on('error', reject)
        setTimeout(() => { ws.close(); resolve() }, 3000)
      })

      expect(received).toHaveLength(1)
      const data = received[0] as Message[]
      expect(data.length).toBeLessThanOrEqual(5)

      // Verify the initialHandler invocation had limit:5 and order:desc
      const initialCall = store.listCalls.find(c => c.limit === 5 && c.order === 'desc')
      expect(initialCall).toBeDefined()
    } finally {
      await app.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Derived reactive filter from queryFilter
// ─────────────────────────────────────────────────────────────────────────────

describe('derived reactive filter from queryFilter', () => {
  it('only pushes rows matching the subscriber context (roomId filter)', async () => {
    const store = makeMessageStore()
    const adapter = new MemoryAdapter()
    const app = createApp({ adapter, port: 0 })
    app.flow('/rooms/:roomId/messages', store, {
      push: 'delta',
      queryFilter: (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
    })
    await app.listen()
    const address = app.getFastify().server.address()
    const port = typeof address === 'object' && address ? address.port : 3000

    const received: unknown[] = []
    const { WebSocket } = await import('ws')

    try {
      // Subscribe to room 1 only
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'subscribe', path: '/rooms/1/messages/live' }))
          // Skip initial push, then simulate a room-2 change (should NOT arrive)
          setTimeout(() => {
            adapter.emit('messages', {
              operation: 'INSERT',
              newRow: { id: 99, roomId: 2, content: 'wrong room' },
              oldRow: null,
              timestamp: Date.now(),
            })
            // Then a room-1 change (should arrive)
            setTimeout(() => {
              adapter.emit('messages', {
                operation: 'INSERT',
                newRow: { id: 100, roomId: 1, content: 'correct room' },
                oldRow: null,
                timestamp: Date.now(),
              })
              setTimeout(() => { ws.close(); resolve() }, 200)
            }, 50)
          }, 200)
        })
        ws.on('message', (raw: Buffer) => {
          const msg = JSON.parse(raw.toString()) as { type: string; data: { row?: Message } }
          if (msg.type === 'update' && msg.data?.row) {
            received.push(msg.data.row)
          }
        })
        ws.on('error', reject)
        setTimeout(resolve, 4000)
      })

      // Only the room-1 message should have been pushed
      const rows = received as Message[]
      expect(rows.every(r => r.roomId === 1)).toBe(true)
      expect(rows.some(r => r.content === 'correct room')).toBe(true)
      expect(rows.some(r => r.content === 'wrong room')).toBe(false)
    } finally {
      await app.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Presence hooks — onConnect / onDisconnect
// ─────────────────────────────────────────────────────────────────────────────

describe('onConnect / onDisconnect presence hooks', () => {
  it('onConnect is called when a WebSocket client connects', async () => {
    const onConnect = vi.fn()
    const onDisconnect = vi.fn()
    const store = makeMessageStore()
    const adapter = new MemoryAdapter()
    const app = createApp({ adapter, port: 0, onConnect, onDisconnect })
    app.flow('/messages', store)
    await app.listen()
    const address = app.getFastify().server.address()
    const port = typeof address === 'object' && address ? address.port : 3000

    const { WebSocket } = await import('ws')
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        ws.on('open', () => setTimeout(() => { ws.close() }, 100))
        ws.on('close', resolve)
        ws.on('error', reject)
      })
      // Small delay for close handler to fire
      await new Promise(r => setTimeout(r, 50))

      expect(onConnect).toHaveBeenCalledOnce()
      const [clientId, req] = onConnect.mock.calls[0]!
      expect(typeof clientId).toBe('string')
      expect(clientId).toMatch(/^[0-9a-f-]{36}$/) // UUID format
      expect(req).toBeDefined() // IncomingMessage

      expect(onDisconnect).toHaveBeenCalledOnce()
      expect(onDisconnect.mock.calls[0]![0]).toBe(clientId) // same clientId
    } finally {
      await app.close()
    }
  })

  it('user hook errors do not crash the server', async () => {
    const throwingConnect = vi.fn(() => { throw new Error('hook error') })
    const store = makeMessageStore()
    const adapter = new MemoryAdapter()
    const app = createApp({ adapter, port: 0, onConnect: throwingConnect })
    app.flow('/messages', store)
    await app.listen()
    const address = app.getFastify().server.address()
    const port = typeof address === 'object' && address ? address.port : 3000

    const { WebSocket } = await import('ws')
    try {
      // Should not throw / crash the process
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        ws.on('open', () => setTimeout(() => { ws.close() }, 100))
        ws.on('close', resolve)
        ws.on('error', reject)
      })
      // Server still alive — can serve HTTP
      const res = await fetch(`${baseUrl(port)}/messages`)
      expect(res.status).toBe(200)
    } finally {
      await app.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. queryFilter + query:'auto' combined
// ─────────────────────────────────────────────────────────────────────────────

describe('queryFilter + query:auto combined', () => {
  it('WHERE from queryFilter AND ?limit from query string both applied', async () => {
    const store = makeMessageStore([
      { id: 1, roomId: 1, content: 'a' },
      { id: 2, roomId: 1, content: 'b' },
      { id: 3, roomId: 1, content: 'c' },
      { id: 4, roomId: 2, content: 'd' },
    ])
    const { app, baseUrl } = await startApp((a) => {
      a.flow('/rooms/:roomId/messages', store, {
        queryFilter: (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
        query: 'auto',
      })
    })
    try {
      const res = await fetch(`${baseUrl}/rooms/1/messages?limit=2`)
      const data = await res.json() as Message[]
      expect(data).toHaveLength(2)
      expect(data.every(m => m.roomId === 1)).toBe(true)
      const call = store.listCalls.at(-1)!
      expect(call.where).toMatchObject({ roomId: 1 })
      expect(call.limit).toBe(2)
    } finally {
      await app.close()
    }
  })
})

// helper
function baseUrl(port: number) { return `http://127.0.0.1:${port}` }
