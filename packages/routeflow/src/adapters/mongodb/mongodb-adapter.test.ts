import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MongoDbAdapter } from './mongodb-adapter.js'

describe('MongoDbAdapter', () => {
  const streamHandlers = new Map<string, (payload: any) => void>()
  const close = vi.fn().mockResolvedValue(undefined)
  const stream = {
    on: vi.fn((event: string, handler: (payload: any) => void) => {
      streamHandlers.set(event, handler)
      return stream
    }),
    close,
  }

  const db = {
    collection: vi.fn(() => ({
      watch: vi.fn(() => stream),
    })),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    streamHandlers.clear()
  })

  it('opens one change stream per watched collection after connect', async () => {
    const adapter = new MongoDbAdapter({ db })
    const listener = vi.fn()

    adapter.onChange('orders', listener)
    await adapter.connect()

    expect(db.collection).toHaveBeenCalledWith('orders')
  })

  it('maps insert/update/delete events to RouteFlow ChangeEvent', async () => {
    const adapter = new MongoDbAdapter({ db })
    const listener = vi.fn()

    await adapter.connect()
    adapter.onChange('orders', listener)

    streamHandlers.get('change')?.({
      operationType: 'insert',
      fullDocument: { _id: 1, total: 99 },
    })
    streamHandlers.get('change')?.({
      operationType: 'update',
      fullDocument: { _id: 1, total: 100 },
      fullDocumentBeforeChange: { _id: 1, total: 99 },
    })
    streamHandlers.get('change')?.({
      operationType: 'delete',
      documentKey: { _id: 1 },
    })

    expect(listener).toHaveBeenCalledTimes(3)
    expect(listener.mock.calls[0][0]).toMatchObject({
      table: 'orders',
      operation: 'INSERT',
      newRow: { _id: 1, total: 99 },
      oldRow: null,
    })
    expect(listener.mock.calls[1][0]).toMatchObject({
      operation: 'UPDATE',
      newRow: { _id: 1, total: 100 },
      oldRow: { _id: 1, total: 99 },
    })
    expect(listener.mock.calls[2][0]).toMatchObject({
      operation: 'DELETE',
      newRow: null,
      oldRow: { _id: 1 },
    })
  })

  it('closes streams on disconnect', async () => {
    const adapter = new MongoDbAdapter({ db })
    adapter.onChange('orders', vi.fn())
    await adapter.connect()
    await adapter.disconnect()

    expect(close).toHaveBeenCalledOnce()
  })
})
