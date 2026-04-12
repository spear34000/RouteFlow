import { describe, expect, it, vi } from 'vitest'
import { PollingAdapter } from './polling-adapter.js'

describe('PollingAdapter', () => {
  it('polls changes and normalises table and timestamp', async () => {
    const listener = vi.fn()
    const readChanges = vi
      .fn()
      .mockResolvedValueOnce({
        events: [{ operation: 'INSERT', newRow: { id: 1 }, oldRow: null }],
        cursor: 1,
      })
      .mockResolvedValueOnce({
        events: [{ operation: 'UPDATE', newRow: { id: 1, name: 'A' }, oldRow: { id: 1 } }],
        cursor: 2,
      })

    const adapter = new PollingAdapter<number>({
      intervalMs: 50,
      now: () => 1234,
      readChanges,
    })

    adapter.onChange('orders', listener)
    await adapter.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toMatchObject({
      table: 'orders',
      operation: 'INSERT',
      timestamp: 1234,
    })

    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(readChanges).toHaveBeenNthCalledWith(1, { table: 'orders', cursor: undefined })
    expect(readChanges).toHaveBeenNthCalledWith(2, { table: 'orders', cursor: 1 })
    expect(listener).toHaveBeenCalledTimes(2)

    await adapter.disconnect()
  })

  it('stops polling after unsubscribe', async () => {
    vi.useFakeTimers()

    const readChanges = vi.fn().mockResolvedValue({ events: [], cursor: undefined })
    const listener = vi.fn()

    const adapter = new PollingAdapter({
      intervalMs: 50,
      readChanges,
    })

    await adapter.connect()
    const unsubscribe = adapter.onChange('orders', listener)
    await Promise.resolve()

    expect(readChanges).toHaveBeenCalledTimes(1)

    unsubscribe()

    await vi.runOnlyPendingTimersAsync()

    expect(readChanges).toHaveBeenCalledTimes(1)
  })
})
