import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MySqlAdapter } from './mysql-adapter.js'

describe('MySqlAdapter', () => {
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

  it('starts the source and subscribes to binlog/error events', async () => {
    const adapter = new MySqlAdapter({ source })
    await adapter.connect()

    expect(source.start).toHaveBeenCalledOnce()
    expect(source.on).toHaveBeenCalledWith('binlog', expect.any(Function))
    expect(source.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('maps write/update/delete row events to RouteFlow ChangeEvent', async () => {
    const adapter = new MySqlAdapter({ source, schema: 'app' })
    const listener = vi.fn()
    adapter.onChange('orders', listener)
    await adapter.connect()

    handlers.get('binlog')?.({
      getTypeName: () => 'WriteRows',
      tableMap: { parentSchema: 'app', tableName: 'orders' },
      rows: [{ id: 1, total: 10 }],
    })
    handlers.get('binlog')?.({
      getTypeName: () => 'UpdateRows',
      tableMap: { parentSchema: 'app', tableName: 'orders' },
      rows: [{ before: { id: 1, total: 10 }, after: { id: 1, total: 20 } }],
    })
    handlers.get('binlog')?.({
      getTypeName: () => 'DeleteRows',
      tableMap: { parentSchema: 'app', tableName: 'orders' },
      rows: [{ id: 1, total: 20 }],
    })

    expect(listener).toHaveBeenCalledTimes(3)
    expect(listener.mock.calls[0][0]).toMatchObject({
      operation: 'INSERT',
      newRow: { id: 1, total: 10 },
      oldRow: null,
    })
    expect(listener.mock.calls[1][0]).toMatchObject({
      operation: 'UPDATE',
      newRow: { id: 1, total: 20 },
      oldRow: { id: 1, total: 10 },
    })
    expect(listener.mock.calls[2][0]).toMatchObject({
      operation: 'DELETE',
      newRow: null,
      oldRow: { id: 1, total: 20 },
    })
  })

  it('ignores events from other schemas', async () => {
    const adapter = new MySqlAdapter({ source, schema: 'app' })
    const listener = vi.fn()
    adapter.onChange('orders', listener)
    await adapter.connect()

    handlers.get('binlog')?.({
      getTypeName: () => 'WriteRows',
      tableMap: { parentSchema: 'other', tableName: 'orders' },
      rows: [{ id: 1 }],
    })

    expect(listener).not.toHaveBeenCalled()
  })
})
