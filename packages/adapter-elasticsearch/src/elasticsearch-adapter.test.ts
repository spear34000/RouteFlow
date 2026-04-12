import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ElasticsearchAdapter } from './elasticsearch-adapter.js'

describe('ElasticsearchAdapter', () => {
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

  it('starts external source on connect', async () => {
    const adapter = new ElasticsearchAdapter({ source })
    await adapter.connect()

    expect(source.start).toHaveBeenCalledOnce()
    expect(source.on).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('maps source events to RouteFlow ChangeEvent', async () => {
    const adapter = new ElasticsearchAdapter({ source })
    const listener = vi.fn()

    adapter.onChange('orders-index', listener)
    await adapter.connect()

    handlers.get('change')?.({
      index: 'orders-index',
      operation: 'INSERT',
      newDocument: { id: 1, total: 10 },
      oldDocument: null,
    })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0]).toMatchObject({
      table: 'orders-index',
      operation: 'INSERT',
      newRow: { id: 1, total: 10 },
      oldRow: null,
    })
  })

  it('ignores indices without listeners', async () => {
    const adapter = new ElasticsearchAdapter({ source })
    const listener = vi.fn()

    adapter.onChange('orders-index', listener)
    await adapter.connect()

    handlers.get('change')?.({
      index: 'other-index',
      operation: 'DELETE',
      newDocument: null,
      oldDocument: { id: 1 },
    })

    expect(listener).not.toHaveBeenCalled()
  })
})
