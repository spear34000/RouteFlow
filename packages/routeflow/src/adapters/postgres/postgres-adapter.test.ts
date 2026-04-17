import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChangeEvent } from '../../core/types.js'

/**
 * Unit tests for PostgresAdapter using a mocked pg.Client.
 *
 * These tests cover:
 *  - Connection lifecycle (connect, idempotency, disconnect)
 *  - onChange() before connect() — trigger installed on connect (bug-fix coverage)
 *  - onChange() after connect() — trigger installed immediately
 *  - NOTIFY payload parsing — INSERT / UPDATE / DELETE / truncated
 *  - event_time from DB payload used as timestamp
 *  - Auto-reconnect via client 'end' event (with reconnectDelayMs:0)
 *  - onError callback
 *  - isConnected getter
 *  - Custom schema / triggerPrefix
 */

// ---------------------------------------------------------------------------
// Mock pg module before importing the adapter
// ---------------------------------------------------------------------------

const mockQuery   = vi.fn().mockResolvedValue({ rows: [] })
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockEnd     = vi.fn().mockResolvedValue(undefined)

type Handler = (...args: any[]) => void
const notificationHandlers: Map<string, Handler> = new Map()
const errorHandlers:        Map<string, Handler> = new Map()
const endHandlers:          Map<string, Handler> = new Map()

const mockClientInstance = {
  connect: mockConnect,
  query:   mockQuery,
  end:     mockEnd,
  on: vi.fn((event: string, handler: Handler) => {
    if (event === 'notification') notificationHandlers.set('notification', handler)
    else if (event === 'error')   errorHandlers.set('error', handler)
    else if (event === 'end')     endHandlers.set('end', handler)
  }),
}

vi.mock('pg', () => ({
  Client:        vi.fn(() => mockClientInstance),
  DatabaseError: class DatabaseError extends Error {},
}))

const { PostgresAdapter } = await import('./postgres-adapter.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitNotification(payload: object): void {
  const handler = notificationHandlers.get('notification')
  if (!handler) throw new Error('No notification handler registered')
  handler({ channel: 'reactive_api_changes', payload: JSON.stringify(payload) })
}

function triggerEnd(): void {
  endHandlers.get('end')?.()
}

async function waitFor(check: () => void, timeoutMs = 250): Promise<void> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      check()
      return
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('waitFor timed out')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresAdapter — unit', () => {
  let adapter: InstanceType<typeof PostgresAdapter>

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset default implementations (clearAllMocks resets call counts but not impls)
    mockConnect.mockResolvedValue(undefined)
    mockQuery.mockResolvedValue({ rows: [] })
    mockEnd.mockResolvedValue(undefined)
    notificationHandlers.clear()
    errorHandlers.clear()
    endHandlers.clear()
    adapter = new PostgresAdapter({ connectionString: 'postgresql://localhost/test' })
  })

  // ── Connection lifecycle ────────────────────────────────────────────────────

  it('connect() calls pg Client.connect, installs trigger function, and LISTENs', async () => {
    await adapter.connect()

    expect(mockConnect).toHaveBeenCalledOnce()
    const queries: string[] = mockQuery.mock.calls.map((c) => String(c[0]))
    expect(queries.some((q) => q.includes('CREATE OR REPLACE FUNCTION'))).toBe(true)
    expect(queries.some((q) => q.toUpperCase().includes('LISTEN'))).toBe(true)
  })

  it('connect() is idempotent — second call does nothing', async () => {
    await adapter.connect()
    const callCount = mockConnect.mock.calls.length
    await adapter.connect()
    expect(mockConnect.mock.calls.length).toBe(callCount)
  })

  it('isConnected reflects connection state', async () => {
    expect(adapter.isConnected).toBe(false)
    await adapter.connect()
    expect(adapter.isConnected).toBe(true)
    await adapter.disconnect()
    expect(adapter.isConnected).toBe(false)
  })

  // ── Trigger installation ───────────────────────────────────────────────────

  it('onChange() after connect() installs a table trigger', async () => {
    await adapter.connect()
    adapter.onChange('orders', vi.fn())

    await Promise.resolve()
    await Promise.resolve()

    const queries: string[] = mockQuery.mock.calls.map((c) => String(c[0]))
    expect(queries.some((q) => q.includes('CREATE TRIGGER'))).toBe(true)
  })

  it('onChange() BEFORE connect() — trigger is installed during connect()', async () => {
    // Register listener before connect
    adapter.onChange('orders', vi.fn())

    // No trigger installed yet — client doesn't exist
    expect(mockQuery).not.toHaveBeenCalled()

    await adapter.connect()
    // Drain microtask queue for floating trigger install promises
    await new Promise((r) => setImmediate(r))

    const queries: string[] = mockQuery.mock.calls.map((c) => String(c[0]))
    expect(queries.some((q) => q.includes('CREATE TRIGGER'))).toBe(true)
  })

  it('trigger install is idempotent — second onChange() for same table skips install', async () => {
    await adapter.connect()
    adapter.onChange('orders', vi.fn())
    await new Promise((r) => setImmediate(r))
    const triggerInstalls1 = mockQuery.mock.calls.filter((c) => String(c[0]).includes('CREATE TRIGGER')).length

    // Second listener on same table — no new trigger install
    adapter.onChange('orders', vi.fn())
    await new Promise((r) => setImmediate(r))
    const triggerInstalls2 = mockQuery.mock.calls.filter((c) => String(c[0]).includes('CREATE TRIGGER')).length

    expect(triggerInstalls2).toBe(triggerInstalls1)
  })

  // ── Event delivery ─────────────────────────────────────────────────────────

  it('delivers INSERT ChangeEvent to listeners', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('orders', cb)

    emitNotification({ table: 'orders', operation: 'INSERT', new_row: { id: 1, total: 99 }, old_row: null })

    expect(cb).toHaveBeenCalledOnce()
    const event: ChangeEvent = cb.mock.calls[0][0]
    expect(event.table).toBe('orders')
    expect(event.operation).toBe('INSERT')
    expect(event.newRow).toEqual({ id: 1, total: 99 })
    expect(event.oldRow).toBeNull()
    expect(typeof event.timestamp).toBe('number')
  })

  it('delivers UPDATE events with both newRow and oldRow', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('users', cb)

    emitNotification({ table: 'users', operation: 'UPDATE', new_row: { id: 5, name: 'Bob' }, old_row: { id: 5, name: 'Alice' } })

    const event: ChangeEvent = cb.mock.calls[0][0]
    expect(event.operation).toBe('UPDATE')
    expect(event.newRow).toEqual({ id: 5, name: 'Bob' })
    expect(event.oldRow).toEqual({ id: 5, name: 'Alice' })
  })

  it('delivers DELETE events with only oldRow', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('items', cb)

    emitNotification({ table: 'items', operation: 'DELETE', new_row: null, old_row: { id: 7 } })

    const event: ChangeEvent = cb.mock.calls[0][0]
    expect(event.operation).toBe('DELETE')
    expect(event.newRow).toBeNull()
    expect(event.oldRow).toEqual({ id: 7 })
  })

  it('uses event_time from DB payload as timestamp (accurate server-side clock)', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('orders', cb)

    const dbTimestamp = 1_712_345_678_901
    emitNotification({
      table: 'orders', operation: 'INSERT',
      new_row: { id: 1 }, old_row: null,
      event_time: dbTimestamp,
    })

    expect(cb.mock.calls[0][0].timestamp).toBe(dbTimestamp)
  })

  it('falls back to Date.now() when event_time is absent', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('orders', cb)

    const before = Date.now()
    emitNotification({ table: 'orders', operation: 'INSERT', new_row: { id: 1 }, old_row: null })
    const after = Date.now()

    const ts = cb.mock.calls[0][0].timestamp as number
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('does not call listener after unsubscribe', async () => {
    await adapter.connect()
    const cb = vi.fn()
    const unsub = adapter.onChange('orders', cb)
    unsub()

    emitNotification({ table: 'orders', operation: 'INSERT', new_row: { id: 1 }, old_row: null })

    expect(cb).not.toHaveBeenCalled()
  })

  it('does not deliver events for a different table', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('users', cb)

    emitNotification({ table: 'orders', operation: 'INSERT', new_row: { id: 1 }, old_row: null })

    expect(cb).not.toHaveBeenCalled()
  })

  it('handles truncated payload gracefully — null rows, event_time preserved', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('orders', cb)

    const ts = 1_712_345_678_901
    emitNotification({ table: 'orders', operation: 'INSERT', new_row: null, old_row: null, _truncated: true, event_time: ts })

    const event: ChangeEvent = cb.mock.calls[0][0]
    expect(event.newRow).toBeNull()
    expect(event.oldRow).toBeNull()
    expect(event.timestamp).toBe(ts)
  })

  it('ignores malformed JSON payloads without throwing', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('orders', cb)

    const handler = notificationHandlers.get('notification')!
    expect(() => {
      handler({ channel: 'reactive_api_changes', payload: 'not-json{{{' })
    }).not.toThrow()

    expect(cb).not.toHaveBeenCalled()
  })

  // ── onError callback ───────────────────────────────────────────────────────

  it('routes pg client errors to onError callback', async () => {
    const onError = vi.fn()
    const a = new PostgresAdapter({ connectionString: 'postgresql://localhost/test', onError })
    await a.connect()

    errorHandlers.get('error')?.(new Error('connection reset'))

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).toMatch(/connection reset/)
  })

  it('routes listener errors to onError callback without throwing', async () => {
    const onError = vi.fn()
    const a = new PostgresAdapter({ connectionString: 'postgresql://localhost/test', onError })
    await a.connect()
    a.onChange('orders', () => { throw new Error('listener boom') })

    expect(() => {
      emitNotification({ table: 'orders', operation: 'INSERT', new_row: { id: 1 }, old_row: null })
    }).not.toThrow()

    expect(onError).toHaveBeenCalledOnce()
  })

  // ── Auto-reconnect ─────────────────────────────────────────────────────────

  it('reconnects when pg client emits "end" (reconnectDelayMs:0)', async () => {
    const a = new PostgresAdapter({
      connectionString: 'postgresql://localhost/test',
      reconnectDelayMs: 0,
      maxReconnectAttempts: 3,
    })
    await a.connect()
    const connectCallsBefore = mockConnect.mock.calls.length

    // Simulate unexpected disconnect
    triggerEnd()

    await waitFor(() => {
      expect(mockConnect.mock.calls.length).toBeGreaterThan(connectCallsBefore)
      expect(a.isConnected).toBe(true)
    })
  })

  it('does NOT reconnect after intentional disconnect()', async () => {
    const a = new PostgresAdapter({
      connectionString: 'postgresql://localhost/test',
      reconnectDelayMs: 0,
    })
    await a.connect()
    await a.disconnect()

    mockConnect.mockClear()

    // 'end' fires as a result of the intentional disconnect — should not reconnect
    triggerEnd()
    await waitFor(() => {
      expect(mockConnect).not.toHaveBeenCalled()
    })
  })

  it('calls onError when max reconnect attempts are exhausted', async () => {
    const onError = vi.fn()
    mockConnect.mockRejectedValue(new Error('host unreachable'))

    const a = new PostgresAdapter({
      connectionString: 'postgresql://localhost/test',
      onError,
      reconnectDelayMs: 0,
      maxReconnectAttempts: 2,
    })

    // First connect succeeds (use the default mockConnect)
    mockConnect.mockResolvedValueOnce(undefined)
    await a.connect()

    // Now simulate disconnect — subsequent connect() calls fail
    triggerEnd()

    // Drain timer + microtask queues across all retry attempts.
    // The reconnect loop uses setTimeout(fn, 0) (reconnectDelayMs=0), which fires in the
    // timers phase.  setImmediate runs in the check phase — its ordering relative to a
    // same-tick setTimeout(0) is non-deterministic in Node.js.  A small real delay (50ms)
    // is both more reliable and more readable than a loop of setImmediate calls.
    await new Promise((r) => setTimeout(r, 50))

    // onError must have been called at least once for the exhausted attempts
    expect(onError).toHaveBeenCalled()
    const messages: string[] = onError.mock.calls.map((c: any) => c[0].message as string)
    const exhaustedMsg = messages.some((m) => m.includes('Max reconnect'))
    expect(exhaustedMsg).toBe(true)
  })

  // ── Disconnect / cleanup ───────────────────────────────────────────────────

  it('disconnect() drops triggers and ends the client', async () => {
    await adapter.connect()
    adapter.onChange('orders', vi.fn())
    await new Promise((r) => setImmediate(r))

    await adapter.disconnect()

    expect(mockEnd).toHaveBeenCalledOnce()
    const queries: string[] = mockQuery.mock.calls.map((c) => String(c[0]))
    expect(queries.some((q) => q.includes('DROP TRIGGER'))).toBe(true)
    expect(queries.some((q) => q.includes('DROP FUNCTION'))).toBe(true)
  })

  // ── Custom schema / prefix ─────────────────────────────────────────────────

  it('uses custom schema and triggerPrefix', async () => {
    const custom = new PostgresAdapter({
      connectionString: 'postgresql://localhost/test',
      schema: 'myschema',
      triggerPrefix: 'myapp',
    })
    await custom.connect()

    const queries: string[] = mockQuery.mock.calls.map((c) => String(c[0]))
    expect(queries.some((q) => q.includes('"myschema"."myapp_notify_changes"'))).toBe(true)
    expect(queries.some((q) => q.includes('LISTEN "myapp_changes"'))).toBe(true)
  })
})
