import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CassandraAdapter } from './cassandra-adapter.js'

describe('CassandraAdapter', () => {
  const handlers = new Map<string, (...args: any[]) => void>()
  const source = {
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event)
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
  })

  it('starts CDC source on connect', async () => {
    const adapter = new CassandraAdapter({ source })
    await adapter.connect()
    expect(source.start).toHaveBeenCalledOnce()
  })

  it('forwards matching table events', async () => {
    const adapter = new CassandraAdapter({ source })
    const listener = vi.fn()
    adapter.onChange('orders', listener)
    await adapter.connect()

    handlers.get('change')?.({
      table: 'orders',
      operation: 'UPDATE',
      newRow: { id: 1, total: 20 },
      oldRow: { id: 1, total: 10 },
    })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0]).toMatchObject({
      table: 'orders',
      operation: 'UPDATE',
      newRow: { id: 1, total: 20 },
      oldRow: { id: 1, total: 10 },
    })
  })
})
