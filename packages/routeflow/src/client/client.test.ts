import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReactiveClient, createClient } from './client.js'
import { ReactiveClientError } from './errors.js'

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const responseHeaders = new Map(Object.entries({ 'content-type': 'application/json', ...headers }))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => responseHeaders.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

// ---------------------------------------------------------------------------
// ReactiveClientError
// ---------------------------------------------------------------------------

describe('ReactiveClientError', () => {
  it('stores code and optional status', () => {
    const err = new ReactiveClientError('HTTP_ERROR', 'not found', 404)
    expect(err.code).toBe('HTTP_ERROR')
    expect(err.status).toBe(404)
    expect(err.message).toBe('not found')
    expect(err.name).toBe('ReactiveClientError')
  })

  it('instanceof Error', () => {
    expect(new ReactiveClientError('X', 'y')).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// createClient
// ---------------------------------------------------------------------------

describe('createClient', () => {
  it('returns a ReactiveClient instance', () => {
    const c = createClient('http://localhost:3000')
    expect(c).toBeInstanceOf(ReactiveClient)
    c.destroy()
  })

  it('trims trailing slash from baseUrl', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]))
    const c = createClient('http://localhost:3000/')
    await c.get('/items')
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/items')
    c.destroy()
  })
})

// ---------------------------------------------------------------------------
// HTTP methods
// ---------------------------------------------------------------------------

describe('ReactiveClient — HTTP', () => {
  let client: ReactiveClient

  beforeEach(() => {
    client = createClient('http://localhost:3000', {
      headers: { Authorization: 'Bearer token' },
    })
    mockFetch.mockReset()
  })

  afterEach(() => {
    client.destroy()
  })

  it('get() sends GET request and returns parsed JSON', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ id: 1 }))
    const result = await client.get<{ id: number }>('/users/1')
    expect(result).toEqual({ id: 1 })
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/users/1', expect.objectContaining({ method: 'GET' }))
  })

  it('get() appends query params', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]))
    await client.get('/items', { page: '2', limit: '10' })
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('page=2')
    expect(url).toContain('limit=10')
  })

  it('post() sends body as JSON', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ id: 5 }, 201))
    await client.post('/orders', { item: 'book' })
    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ item: 'book' }))
  })

  it('put() sends PUT request', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }))
    await client.put('/orders/1', { total: 99 })
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('PUT')
  })

  it('patch() sends PATCH request', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }))
    await client.patch('/orders/1', { status: 'shipped' })
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('PATCH')
  })

  it('del() sends DELETE request', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(null, 204, { 'content-length': '0' }))
    await client.del('/orders/1')
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('DELETE')
  })

  it('merges default and per-request headers', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}))
    await client.get('/x', undefined, { 'X-Custom': 'yes' })
    const headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer token')
    expect(headers['X-Custom']).toBe('yes')
  })

  it('throws ReactiveClientError on non-ok response with correct status', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: 'Not found' }, 404))
    let caught: unknown
    try {
      await client.get('/missing')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ReactiveClientError)
    expect((caught as ReactiveClientError).status).toBe(404)
  })

  it('throws ReactiveClientError with code HTTP_ERROR on non-ok', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('oops', 500))
    try {
      await client.get('/fail')
    } catch (e) {
      expect(e).toBeInstanceOf(ReactiveClientError)
      expect((e as ReactiveClientError).code).toBe('HTTP_ERROR')
    }
  })

  it('throws ReactiveClientError with code NETWORK_ERROR on fetch failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'))
    try {
      await client.get('/fail')
    } catch (e) {
      expect(e).toBeInstanceOf(ReactiveClientError)
      expect((e as ReactiveClientError).code).toBe('NETWORK_ERROR')
    }
  })

  it('returns undefined for 204 No Content', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(null, 204, { 'content-length': '0' }))
    const result = await client.del('/x')
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// WebSocket / subscribe — using a mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: string) { this.sent.push(data) }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.() }

  // Test helper — simulate server opening the connection
  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  // Test helper — simulate a message from the server
  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  static instances: MockWebSocket[] = []
  static reset() { MockWebSocket.instances = [] }
}

vi.stubGlobal('WebSocket', MockWebSocket)

describe('ReactiveClient — subscribe', () => {
  let client: ReactiveClient

  beforeEach(() => {
    MockWebSocket.reset()
    client = createClient('http://localhost:3000')
  })

  afterEach(() => {
    client.destroy()
  })

  function getWs(): MockWebSocket {
    return MockWebSocket.instances[0]!
  }

  it('subscribe() opens a WebSocket connection', () => {
    const cb = vi.fn()
    client.subscribe('/items/live', cb)
    expect(MockWebSocket.instances.length).toBe(1)
    expect(getWs().url).toBe('ws://localhost:3000')
  })

  it('sends subscribe message when socket opens', () => {
    const cb = vi.fn()
    client.subscribe('/items/live', cb)
    getWs().open()
    expect(getWs().sent.length).toBe(1)
    expect(JSON.parse(getWs().sent[0]!)).toEqual({ type: 'subscribe', path: '/items/live' })
  })

  it('delivers update to callback', () => {
    const cb = vi.fn()
    client.subscribe('/items/live', cb)
    getWs().open()
    getWs().receive({ type: 'update', path: '/items/live', data: [{ id: 1 }] })
    expect(cb).toHaveBeenCalledWith([{ id: 1 }])
  })

  it('does not deliver updates to unsubscribed callback', () => {
    const cb = vi.fn()
    const unsub = client.subscribe('/items/live', cb)
    getWs().open()
    unsub()
    getWs().receive({ type: 'update', path: '/items/live', data: [{ id: 2 }] })
    expect(cb).not.toHaveBeenCalled()
  })

  it('does not deliver updates for a different path', () => {
    const cb = vi.fn()
    client.subscribe('/items/live', cb)
    getWs().open()
    getWs().receive({ type: 'update', path: '/other/live', data: [] })
    expect(cb).not.toHaveBeenCalled()
  })

  it('sends subscribe with query params', () => {
    const cb = vi.fn()
    client.subscribe('/orders/live', cb, { userId: '42' })
    getWs().open()
    const msg = JSON.parse(getWs().sent[0]!)
    expect(msg.query).toEqual({ userId: '42' })
  })

  it('restores subscriptions after reconnect', () => {
    vi.useFakeTimers()
    const cb = vi.fn()
    client.subscribe('/items/live', cb)
    const ws1 = getWs()
    ws1.open()
    expect(ws1.sent.length).toBe(1)

    // Simulate disconnect → schedules reconnect via setTimeout
    ws1.onclose?.()

    // Advance timers past the initial reconnect delay (500ms default)
    vi.advanceTimersByTime(600)

    // New WebSocket should have been created
    expect(MockWebSocket.instances.length).toBe(2)
    const ws2 = MockWebSocket.instances[1]!
    ws2.open()

    // Subscribe message should be re-sent on ws2
    expect(ws2.sent.length).toBe(1)
    expect(JSON.parse(ws2.sent[0]!)).toMatchObject({ type: 'subscribe', path: '/items/live' })
    vi.useRealTimers()
  })

  it('multiple subscribers on the same path all receive updates', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    client.subscribe('/items/live', cb1)
    client.subscribe('/items/live', cb2)
    getWs().open()
    getWs().receive({ type: 'update', path: '/items/live', data: 'x' })
    expect(cb1).toHaveBeenCalledWith('x')
    expect(cb2).toHaveBeenCalledWith('x')
  })

  it('destroy() closes the socket and clears subscriptions', () => {
    const cb = vi.fn()
    client.subscribe('/items/live', cb)
    getWs().open()
    client.destroy()
    // After destroy, no new ws should be opened on further messages
    getWs().receive({ type: 'update', path: '/items/live', data: [] })
    expect(cb).not.toHaveBeenCalled()
  })
})
