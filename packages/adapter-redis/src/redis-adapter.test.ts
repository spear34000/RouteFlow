import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RedisAdapter } from './redis-adapter.js'

describe('RedisAdapter', () => {
  const handlers = new Map<string, (...args: any[]) => void>()
  const subscriber = {
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event)
    }),
    quit: vi.fn().mockResolvedValue(undefined),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
  })

  it('subscribes watched tables on connect', async () => {
    const adapter = new RedisAdapter({ subscriber })
    adapter.onChange('orders', vi.fn())

    await adapter.connect()

    expect(subscriber.subscribe).toHaveBeenCalledWith('flux:orders')
  })

  it('maps Redis pub/sub payloads to RouteFlow ChangeEvent', async () => {
    const adapter = new RedisAdapter({ subscriber, channelPrefix: 'app' })
    const listener = vi.fn()

    adapter.onChange('orders', listener)
    await adapter.connect()

    handlers.get('message')?.(
      'app:orders',
      JSON.stringify({
        table: 'orders',
        operation: 'UPDATE',
        newRow: { id: 1, total: 20 },
        oldRow: { id: 1, total: 10 },
      }),
    )

    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0]).toMatchObject({
      table: 'orders',
      operation: 'UPDATE',
      newRow: { id: 1, total: 20 },
      oldRow: { id: 1, total: 10 },
    })
  })

  it('unsubscribes a table when its last listener is removed', async () => {
    const adapter = new RedisAdapter({ subscriber })
    const unsubscribe = adapter.onChange('orders', vi.fn())
    await adapter.connect()

    unsubscribe()

    expect(subscriber.unsubscribe).toHaveBeenCalledWith('flux:orders')
  })
})
