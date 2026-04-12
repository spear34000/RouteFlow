import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChangeEvent } from '../../core/types.js'

/**
 * Unit tests for PostgresAdapter using a mocked pg.Client.
 *
 * These tests cover the adapter's internal logic — listener management,
 * NOTIFY payload parsing, and trigger installation flow — without a real DB.
 *
 * Integration tests that require a live PostgreSQL instance are in
 * src/postgres-adapter.integration.test.ts and run via:
 *   pnpm test:integration
 */

// ---------------------------------------------------------------------------
// Mock pg module before importing the adapter
// ---------------------------------------------------------------------------

const mockQuery = vi.fn().mockResolvedValue({ rows: [] })
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockEnd = vi.fn().mockResolvedValue(undefined)
const notificationHandlers: Map<string, (msg: { channel: string; payload: string }) => void> =
  new Map()
const errorHandlers: Map<string, (err: Error) => void> = new Map()

const mockClientInstance = {
  connect: mockConnect,
  query: mockQuery,
  end: mockEnd,
  on: vi.fn((event: string, handler: unknown) => {
    if (event === 'notification') {
      notificationHandlers.set('notification', handler as (msg: { channel: string; payload: string }) => void)
    } else if (event === 'error') {
      errorHandlers.set('error', handler as (err: Error) => void)
    }
  }),
}

vi.mock('pg', () => ({
  Client: vi.fn(() => mockClientInstance),
  DatabaseError: class DatabaseError extends Error {},
}))

// Import adapter AFTER mock is set up
const { PostgresAdapter } = await import('./postgres-adapter.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitNotification(payload: object): void {
  const handler = notificationHandlers.get('notification')
  if (!handler) throw new Error('No notification handler registered')
  handler({ channel: 'reactive_api_changes', payload: JSON.stringify(payload) })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresAdapter — unit', () => {
  let adapter: InstanceType<typeof PostgresAdapter>

  beforeEach(() => {
    vi.clearAllMocks()
    notificationHandlers.clear()
    errorHandlers.clear()
    mockQuery.mockResolvedValue({ rows: [] })
    adapter = new PostgresAdapter({ connectionString: 'postgresql://localhost/test' })
  })

  it('connect() calls pg Client.connect, installs trigger function, and LISTENs', async () => {
    await adapter.connect()

    expect(mockConnect).toHaveBeenCalledOnce()
    // Should have: CREATE OR REPLACE FUNCTION, LISTEN
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

  it('onChange() installs a table trigger after connect()', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('orders', cb)

    // Allow the async trigger install to run
    await Promise.resolve()
    await Promise.resolve()

    const queries: string[] = mockQuery.mock.calls.map((c) => String(c[0]))
    expect(queries.some((q) => q.includes('CREATE TRIGGER'))).toBe(true)
  })

  it('delivers a ChangeEvent to listeners when NOTIFY fires', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('orders', cb)

    emitNotification({
      table: 'orders',
      operation: 'INSERT',
      new_row: { id: 1, total: 99 },
      old_row: null,
    })

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

    emitNotification({
      table: 'users',
      operation: 'UPDATE',
      new_row: { id: 5, name: 'Bob' },
      old_row: { id: 5, name: 'Alice' },
    })

    const event: ChangeEvent = cb.mock.calls[0][0]
    expect(event.operation).toBe('UPDATE')
    expect(event.newRow).toEqual({ id: 5, name: 'Bob' })
    expect(event.oldRow).toEqual({ id: 5, name: 'Alice' })
  })

  it('delivers DELETE events with only oldRow', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('items', cb)

    emitNotification({
      table: 'items',
      operation: 'DELETE',
      new_row: null,
      old_row: { id: 7 },
    })

    const event: ChangeEvent = cb.mock.calls[0][0]
    expect(event.operation).toBe('DELETE')
    expect(event.newRow).toBeNull()
    expect(event.oldRow).toEqual({ id: 7 })
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

  it('handles truncated payload gracefully (null rows)', async () => {
    await adapter.connect()
    const cb = vi.fn()
    adapter.onChange('orders', cb)

    emitNotification({
      table: 'orders',
      operation: 'INSERT',
      new_row: null,
      old_row: null,
      _truncated: true,
    })

    const event: ChangeEvent = cb.mock.calls[0][0]
    expect(event.newRow).toBeNull()
    expect(event.oldRow).toBeNull()
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

  it('disconnect() cleans up triggers and ends the client', async () => {
    await adapter.connect()
    adapter.onChange('orders', vi.fn())
    // Drain microtask queue: ensureTriggerInstalled is a floating promise;
    // setImmediate fires after all pending microtasks have settled.
    await new Promise((r) => setImmediate(r))

    await adapter.disconnect()

    expect(mockEnd).toHaveBeenCalledOnce()
    const queries: string[] = mockQuery.mock.calls.map((c) => String(c[0]))
    expect(queries.some((q) => q.includes('DROP TRIGGER'))).toBe(true)
    expect(queries.some((q) => q.includes('DROP FUNCTION'))).toBe(true)
  })

  it('uses custom schema and triggerPrefix', async () => {
    const custom = new PostgresAdapter({
      connectionString: 'postgresql://localhost/test',
      schema: 'myschema',
      triggerPrefix: 'myapp',
    })
    await custom.connect()

    const queries: string[] = mockQuery.mock.calls.map((c) => String(c[0]))
    expect(queries.some((q) => q.includes('myschema.myapp_notify_changes'))).toBe(true)
    expect(queries.some((q) => q.includes("LISTEN \"myapp_changes\""))).toBe(true)
  })
})
