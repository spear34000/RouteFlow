import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DynamoDbAdapter } from './dynamodb-adapter.js'

describe('DynamoDbAdapter', () => {
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

  it('starts the stream source on connect', async () => {
    const adapter = new DynamoDbAdapter({ source })
    await adapter.connect()

    expect(source.start).toHaveBeenCalledOnce()
  })

  it('maps insert/modify/remove records to RouteFlow ChangeEvent', async () => {
    const adapter = new DynamoDbAdapter({ source })
    const listener = vi.fn()
    adapter.onChange('orders', listener)
    await adapter.connect()

    handlers.get('record')?.({
      eventName: 'INSERT',
      eventSourceARN: 'arn:aws:dynamodb:ap-northeast-2:123456789012:table/orders/stream/x',
      dynamodb: { NewImage: { id: { N: '1' }, total: { N: '10' } } },
    })
    handlers.get('record')?.({
      eventName: 'MODIFY',
      eventSourceARN: 'arn:aws:dynamodb:ap-northeast-2:123456789012:table/orders/stream/x',
      dynamodb: {
        NewImage: { id: { N: '1' }, total: { N: '20' } },
        OldImage: { id: { N: '1' }, total: { N: '10' } },
      },
    })
    handlers.get('record')?.({
      eventName: 'REMOVE',
      eventSourceARN: 'arn:aws:dynamodb:ap-northeast-2:123456789012:table/orders/stream/x',
      dynamodb: { OldImage: { id: { N: '1' }, total: { N: '20' } } },
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

  it('ignores records for tables without listeners', async () => {
    const adapter = new DynamoDbAdapter({ source })
    const listener = vi.fn()
    adapter.onChange('orders', listener)
    await adapter.connect()

    handlers.get('record')?.({
      eventName: 'INSERT',
      eventSourceARN: 'arn:aws:dynamodb:ap-northeast-2:123456789012:table/users/stream/x',
      dynamodb: { NewImage: { id: { N: '1' } } },
    })

    expect(listener).not.toHaveBeenCalled()
  })
})
