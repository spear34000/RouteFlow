/**
 * Integration tests for:
 *  - app.flow()   — CRUD + reactive endpoint generation
 *  - app.openapi() — spec serving + Swagger UI
 *  - rateLimit()  — 429 enforcement
 *  - @Get/@Post/@Delete shorthand decorators
 *  - body() helper
 *  - FastAPIClient (createFastAPIClient)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp } from './index.js'
import { MemoryAdapter } from './core/adapter/memory-adapter.js'
import { rateLimit } from './middleware/rate-limit.js'
import { body } from './core/body.js'
import { Get, Post, Delete } from './core/decorator/route.js'
import { Reactive } from './core/decorator/reactive.js'
import { Route } from './core/decorator/route.js'
import { createFastAPIClient, FastAPIError } from './integrations/fastapi.js'
import type { Context, TableStore } from './core/types.js'

// ── Minimal in-memory TableStore for tests ────────────────────────────────────

interface TestRow { id: number; name: string }

function makeStore(initial: TestRow[] = []): TableStore<TestRow> {
  let seq = initial.length
  const rows = [...initial]
  return {
    list:   async ()       => [...rows],
    get:    async (id)     => rows.find((r) => r.id === id) ?? null,
    create: async (data)   => { const r = { id: ++seq, ...data } as TestRow; rows.push(r); return r },
    update: async (id, d)  => {
      const i = rows.findIndex((r) => r.id === id)
      if (i === -1) return null
      rows[i] = { ...rows[i], ...d } as TestRow
      return rows[i]
    },
    delete: async (id) => {
      const i = rows.findIndex((r) => r.id === id)
      if (i === -1) return false
      rows.splice(i, 1)
      return true
    },
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function startApp(setup: (app: ReturnType<typeof createApp>) => void) {
  const adapter = new MemoryAdapter()
  const app     = createApp({ adapter, port: 0 })   // port:0 = random free port
  setup(app)
  await app.listen()
  const address = app.getFastify().server.address()
  const port    = typeof address === 'object' && address ? address.port : 3000
  return { app, baseUrl: `http://127.0.0.1:${port}` }
}

// ── flow() — CRUD generation ──────────────────────────────────────────────────

describe('app.flow()', () => {
  let app: ReturnType<typeof createApp>
  let baseUrl: string

  beforeEach(async () => {
    const store = makeStore([{ id: 1, name: 'Apple' }])
    ;({ app, baseUrl } = await startApp((a) => a.flow('/items', store)))
  })

  afterEach(async () => { await app.close() })

  it('GET /items returns list', async () => {
    const res  = await fetch(`${baseUrl}/items`)
    const data = await res.json() as TestRow[]
    expect(res.status).toBe(200)
    expect(data).toEqual([{ id: 1, name: 'Apple' }])
  })

  it('GET /items/:id returns single row', async () => {
    const res  = await fetch(`${baseUrl}/items/1`)
    const data = await res.json() as TestRow
    expect(res.status).toBe(200)
    expect(data.name).toBe('Apple')
  })

  it('GET /items/:id returns 404 for missing row', async () => {
    const res = await fetch(`${baseUrl}/items/999`)
    expect(res.status).toBe(404)
  })

  it('POST /items creates a row', async () => {
    const res  = await fetch(`${baseUrl}/items`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: 'Banana' }),
    })
    const data = await res.json() as TestRow
    expect(res.status).toBe(200)
    expect(data.name).toBe('Banana')
    expect(typeof data.id).toBe('number')
  })

  it('PUT /items/:id updates a row', async () => {
    const res  = await fetch(`${baseUrl}/items/1`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: 'Mango' }),
    })
    const data = await res.json() as TestRow
    expect(res.status).toBe(200)
    expect(data.name).toBe('Mango')
  })

  it('PUT /items/:id returns 404 for missing row', async () => {
    const res = await fetch(`${baseUrl}/items/999`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: 'Ghost' }),
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /items/:id deletes a row', async () => {
    const res  = await fetch(`${baseUrl}/items/1`, { method: 'DELETE' })
    const data = await res.json() as { ok: boolean }
    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
  })

  it('DELETE /items/:id returns ok:false for missing row', async () => {
    const res  = await fetch(`${baseUrl}/items/999`, { method: 'DELETE' })
    const data = await res.json() as { ok: boolean }
    expect(res.status).toBe(200)
    expect(data.ok).toBe(false)
  })

  it('GET /items/live exists as an HTTP endpoint', async () => {
    const res = await fetch(`${baseUrl}/items/live`)
    expect(res.status).toBe(200)
  })
})

// ── flow() — only option ──────────────────────────────────────────────────────

describe('app.flow() only option', () => {
  let app: ReturnType<typeof createApp>
  let baseUrl: string

  beforeEach(async () => {
    const store = makeStore([{ id: 1, name: 'Apple' }])
    ;({ app, baseUrl } = await startApp((a) =>
      a.flow('/items', store, { only: ['list', 'get'] }),
    ))
  })

  afterEach(async () => { await app.close() })

  it('GET /items is registered', async () => {
    expect((await fetch(`${baseUrl}/items`)).status).toBe(200)
  })

  it('POST /items is NOT registered (405)', async () => {
    const res = await fetch(`${baseUrl}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('GET /items/live is NOT registered', async () => {
    const res = await fetch(`${baseUrl}/items/live`)
    expect(res.status).toBe(404)
  })
})

// ── openapi() ────────────────────────────────────────────────────────────────

describe('app.openapi()', () => {
  let app: ReturnType<typeof createApp>
  let baseUrl: string

  beforeEach(async () => {
    const store = makeStore()
    ;({ app, baseUrl } = await startApp((a) =>
      a.flow('/items', store).openapi({ title: 'Test API', version: '2.0.0' }),
    ))
  })

  afterEach(async () => { await app.close() })

  it('GET /openapi.json returns a valid OpenAPI 3.0 spec', async () => {
    const res  = await fetch(`${baseUrl}/openapi.json`)
    const spec = await res.json() as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(spec['openapi']).toBe('3.0.0')
    expect((spec['info'] as Record<string, string>)['title']).toBe('Test API')
    expect((spec['info'] as Record<string, string>)['version']).toBe('2.0.0')
  })

  it('spec includes all generated routes', async () => {
    const res   = await fetch(`${baseUrl}/openapi.json`)
    const spec  = await res.json() as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)
    expect(paths).toContain('/items')
    expect(paths).toContain('/items/:id')
    expect(paths).toContain('/items/live')
  })

  it('reactive endpoint is flagged with x-routeflow-reactive', async () => {
    const res  = await fetch(`${baseUrl}/openapi.json`)
    const spec = await res.json() as { paths: Record<string, Record<string, Record<string, unknown>>> }
    expect(spec.paths['/items/live']?.['get']?.['x-routeflow-reactive']).toBe(true)
  })

  it('GET /_docs returns HTML with Swagger UI', async () => {
    const res  = await fetch(`${baseUrl}/_docs`)
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('swagger-ui')
    expect(html).toContain('Test API')
  })

  it('GET /openapi.json has Content-Type application/json', async () => {
    const res = await fetch(`${baseUrl}/openapi.json`)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})

// ── openapi() lazy build — routes registered AFTER openapi() appear in spec ──

describe('app.openapi() lazy spec build', () => {
  let app: ReturnType<typeof createApp>
  let baseUrl: string

  beforeEach(async () => {
    const storeA = makeStore()
    const storeB = makeStore()
    ;({ app, baseUrl } = await startApp((a) => {
      a.flow('/alpha', storeA)
        .openapi({ title: 'Lazy Test' })  // called before /beta is registered
        .flow('/beta', storeB)            // registered AFTER openapi()
    }))
  })

  afterEach(async () => { await app.close() })

  it('spec includes routes registered before openapi()', async () => {
    const spec  = await (await fetch(`${baseUrl}/openapi.json`)).json() as { paths: Record<string, unknown> }
    expect(Object.keys(spec.paths)).toContain('/alpha')
  })

  it('spec includes routes registered after openapi()', async () => {
    const spec  = await (await fetch(`${baseUrl}/openapi.json`)).json() as { paths: Record<string, unknown> }
    expect(Object.keys(spec.paths)).toContain('/beta')
  })
})

// ── rateLimit() ───────────────────────────────────────────────────────────────

describe('rateLimit()', () => {
  let app: ReturnType<typeof createApp>
  let baseUrl: string

  beforeEach(async () => {
    ;({ app, baseUrl } = await startApp((a) => {
      a.use(rateLimit({ max: 3, windowMs: 60_000 }))
      a.flow('/items', makeStore([{ id: 1, name: 'Apple' }]))
    }))
  })

  afterEach(async () => { await app.close() })

  it('allows requests within the limit', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/items`)
      expect(res.status).toBe(200)
    }
  })

  it('returns 429 after limit is exceeded', async () => {
    for (let i = 0; i < 3; i++) await fetch(`${baseUrl}/items`)
    const res = await fetch(`${baseUrl}/items`)
    expect(res.status).toBe(429)
  })

  it('429 response contains error code', async () => {
    for (let i = 0; i < 3; i++) await fetch(`${baseUrl}/items`)
    const data = await (await fetch(`${baseUrl}/items`)).json() as Record<string, string>
    expect(data['error']).toBe('RATE_LIMITED')
  })
})

// ── @Get / @Post / @Delete decorators ────────────────────────────────────────

describe('HTTP shorthand decorators', () => {
  let app: ReturnType<typeof createApp>
  let baseUrl: string

  beforeEach(async () => {
    const store = makeStore([{ id: 1, name: 'Apple' }])

    class PingController {
      @Get('/ping')
      async ping(_ctx: Context) { return { pong: true } }

      @Post('/echo')
      async echo(ctx: Context) { return body<{ msg: string }>(ctx) }

      @Reactive({ watch: 'items' })
      @Route('GET', '/items/live')
      async live(_ctx: Context) { return store.list() }

      @Delete('/noop/:id')
      async noop(_ctx: Context) { return { deleted: true } }
    }

    ;({ app, baseUrl } = await startApp((a) => {
      a.register(new PingController())
    }))
  })

  afterEach(async () => { await app.close() })

  it('@Get registers a GET route', async () => {
    const res  = await fetch(`${baseUrl}/ping`)
    const data = await res.json() as { pong: boolean }
    expect(res.status).toBe(200)
    expect(data.pong).toBe(true)
  })

  it('@Post registers a POST route', async () => {
    const res  = await fetch(`${baseUrl}/echo`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ msg: 'hello' }),
    })
    const data = await res.json() as { msg: string }
    expect(res.status).toBe(200)
    expect(data.msg).toBe('hello')
  })

  it('@Delete registers a DELETE route', async () => {
    const res = await fetch(`${baseUrl}/noop/42`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})

// ── body() helper ─────────────────────────────────────────────────────────────

describe('body() helper', () => {
  it('returns Partial<T> from a plain object body', () => {
    const ctx = { body: { name: 'Apple' }, params: {}, query: {}, headers: {} }
    expect(body<{ name: string }>(ctx)).toEqual({ name: 'Apple' })
  })

  it('returns {} for null body', () => {
    expect(body({ body: null, params: {}, query: {}, headers: {} })).toEqual({})
  })

  it('returns {} for undefined body', () => {
    expect(body({ body: undefined, params: {}, query: {}, headers: {} })).toEqual({})
  })

  it('returns {} for array body', () => {
    expect(body({ body: [1, 2, 3], params: {}, query: {}, headers: {} })).toEqual({})
  })

  it('returns {} for string body', () => {
    expect(body({ body: 'raw', params: {}, query: {}, headers: {} })).toEqual({})
  })
})

// ── FastAPIClient ─────────────────────────────────────────────────────────────

describe('createFastAPIClient', () => {
  it('constructs a client with baseUrl', () => {
    const client = createFastAPIClient({ baseUrl: 'http://localhost:8000' })
    expect(client).toBeDefined()
    expect(typeof client.get).toBe('function')
    expect(typeof client.post).toBe('function')
    expect(typeof client.put).toBe('function')
    expect(typeof client.patch).toBe('function')
    expect(typeof client.del).toBe('function')
  })

  it('throws FastAPIError on network failure', async () => {
    const client = createFastAPIClient({
      baseUrl: 'http://127.0.0.1:19999',  // nothing listening here
      timeoutMs: 500,
    })
    await expect(client.get('/test')).rejects.toThrow(FastAPIError)
  })

  it('throws FastAPIError with NETWORK_ERROR code on connection refused', async () => {
    const client = createFastAPIClient({
      baseUrl: 'http://127.0.0.1:19999',
      timeoutMs: 500,
    })
    try {
      await client.get('/test')
    } catch (err) {
      expect(err).toBeInstanceOf(FastAPIError)
      expect((err as FastAPIError).code).toBe('NETWORK_ERROR')
    }
  })

  it('FastAPIClient calls the real server', async () => {
    const store = makeStore([{ id: 1, name: 'Apple' }])
    const { app, baseUrl } = await startApp((a) =>
      a.flow('/items', store).openapi(),
    )
    try {
      const client = createFastAPIClient({ baseUrl })
      const items  = await client.get<TestRow[]>('/items')
      expect(items).toEqual([{ id: 1, name: 'Apple' }])

      const created = await client.post<TestRow>('/items', { name: 'Banana' })
      expect(created.name).toBe('Banana')
      expect(typeof created.id).toBe('number')
    } finally {
      await app.close()
    }
  })

  it('FastAPIClient throws FastAPIError with HTTP_ERROR code on 404', async () => {
    const store = makeStore()
    const { app, baseUrl } = await startApp((a) => a.flow('/items', store))
    try {
      const client = createFastAPIClient({ baseUrl })
      await expect(client.get('/items/999')).rejects.toThrow(FastAPIError)
      try {
        await client.get('/items/999')
      } catch (err) {
        expect((err as FastAPIError).code).toBe('HTTP_ERROR')
        expect((err as FastAPIError).statusCode).toBe(404)
      }
    } finally {
      await app.close()
    }
  })
})
