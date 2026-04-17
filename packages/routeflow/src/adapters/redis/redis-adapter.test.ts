import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RedisAdapter } from './redis-adapter.js'
import { RedisPublisher } from './redis-publisher.js'

// ── Shared mock subscriber ────────────────────────────────────────────────────

function makeSubscriber() {
  const handlers = new Map<string, (...args: any[]) => void>()
  return {
    handlers,
    subscribe:   vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    on:  vi.fn((event: string, handler: (...args: any[]) => void) => { handlers.set(event, handler) }),
    off: vi.fn((event: string) => { handlers.delete(event) }),
    quit: vi.fn().mockResolvedValue(undefined),
  }
}

// ── RedisAdapter ──────────────────────────────────────────────────────────────

describe('RedisAdapter', () => {
  let subscriber: ReturnType<typeof makeSubscriber>

  beforeEach(() => { subscriber = makeSubscriber() })

  it('subscribes watched tables on connect', async () => {
    const adapter = new RedisAdapter({ subscriber })
    adapter.onChange('orders', vi.fn())
    await adapter.connect()
    expect(subscriber.subscribe).toHaveBeenCalledWith('flux:orders')
  })

  it('isConnected returns true after connect and false before', async () => {
    const adapter = new RedisAdapter({ subscriber })
    expect(adapter.isConnected).toBe(false)
    await adapter.connect()
    expect(adapter.isConnected).toBe(true)
    await adapter.disconnect()
    expect(adapter.isConnected).toBe(false)
  })

  it('maps Redis pub/sub payloads to RouteFlow ChangeEvent', async () => {
    const adapter = new RedisAdapter({ subscriber, channelPrefix: 'app' })
    const listener = vi.fn()
    adapter.onChange('orders', listener)
    await adapter.connect()

    subscriber.handlers.get('message')?.(
      'app:orders',
      JSON.stringify({
        table: 'orders', operation: 'UPDATE',
        newRow: { id: 1, total: 20 }, oldRow: { id: 1, total: 10 },
      }),
    )

    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0]).toMatchObject({
      table: 'orders', operation: 'UPDATE',
      newRow: { id: 1, total: 20 }, oldRow: { id: 1, total: 10 },
    })
  })

  it('preserves payload timestamp when provided', async () => {
    const adapter = new RedisAdapter({ subscriber })
    const listener = vi.fn()
    adapter.onChange('orders', listener)
    await adapter.connect()

    const ts = 1_700_000_000_000
    subscriber.handlers.get('message')?.(
      'flux:orders',
      JSON.stringify({ table: 'orders', operation: 'INSERT', newRow: { id: 1 }, oldRow: null, timestamp: ts }),
    )

    expect(listener.mock.calls[0][0].timestamp).toBe(ts)
  })

  it('falls back to Date.now() when payload has no timestamp', async () => {
    const adapter = new RedisAdapter({ subscriber })
    const listener = vi.fn()
    adapter.onChange('orders', listener)
    await adapter.connect()

    const before = Date.now()
    subscriber.handlers.get('message')?.(
      'flux:orders',
      JSON.stringify({ table: 'orders', operation: 'INSERT', newRow: { id: 1 }, oldRow: null }),
    )
    const after = Date.now()

    const ts = listener.mock.calls[0][0].timestamp as number
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('unsubscribes a table when its last listener is removed', async () => {
    const adapter = new RedisAdapter({ subscriber })
    const unsubscribe = adapter.onChange('orders', vi.fn())
    await adapter.connect()
    unsubscribe()
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('flux:orders')
  })

  it('does NOT unsubscribe while a second listener is still registered', async () => {
    const adapter = new RedisAdapter({ subscriber })
    const unsub1 = adapter.onChange('orders', vi.fn())
    adapter.onChange('orders', vi.fn()) // second listener
    await adapter.connect()

    unsub1()

    expect(subscriber.unsubscribe).not.toHaveBeenCalled()
  })

  it('does not deliver events to a different table', async () => {
    const adapter = new RedisAdapter({ subscriber })
    const cb = vi.fn()
    adapter.onChange('users', cb)
    await adapter.connect()

    subscriber.handlers.get('message')?.(
      'flux:orders',
      JSON.stringify({ table: 'orders', operation: 'INSERT', newRow: { id: 1 }, oldRow: null }),
    )

    expect(cb).not.toHaveBeenCalled()
  })

  it('uses Buffer.byteLength for oversized payload check (multi-byte UTF-8)', async () => {
    const onError = vi.fn()
    const adapter = new RedisAdapter({ subscriber, onError })
    const listener = vi.fn()
    adapter.onChange('messages', listener)
    await adapter.connect()

    // Build a payload that is > 1 MiB in bytes using multi-byte chars.
    // Each '€' is 3 bytes in UTF-8 but only 1 JS char — so string.length != byte count.
    const bigContent = '€'.repeat(400_000) // 1.2 MiB bytes, only 400 000 JS chars
    const payload = JSON.stringify({
      table: 'messages', operation: 'INSERT',
      newRow: { id: 1, content: bigContent }, oldRow: null,
    })

    // Verify that JS char length alone would NOT catch this (< 1 048 576 chars)
    expect(payload.length).toBeLessThan(1_048_576)
    // But byte length does exceed the limit
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(1_048_576)

    subscriber.handlers.get('message')?.(
      'flux:messages', payload,
    )

    // Listener must NOT fire — payload was dropped
    expect(listener).not.toHaveBeenCalled()
    // onError must have been called
    expect(onError).toHaveBeenCalledOnce()
  })

  it('re-subscribes to all channels on reconnect (ready event)', async () => {
    const adapter = new RedisAdapter({ subscriber })
    adapter.onChange('orders', vi.fn())
    adapter.onChange('items', vi.fn())
    await adapter.connect()

    // Reset subscribe mock to count only re-subscribes
    subscriber.subscribe.mockClear()

    // Simulate reconnect via 'ready' event
    subscriber.handlers.get('ready')?.()

    expect(subscriber.subscribe).toHaveBeenCalledWith('flux:orders')
    expect(subscriber.subscribe).toHaveBeenCalledWith('flux:items')
  })

  it('calls onError for malformed JSON payloads without throwing', async () => {
    const onError = vi.fn()
    const adapter = new RedisAdapter({ subscriber, onError })
    adapter.onChange('orders', vi.fn())
    await adapter.connect()

    expect(() => {
      subscriber.handlers.get('message')?.(
        'flux:orders', '{not-valid-json',
      )
    }).not.toThrow()

    expect(onError).toHaveBeenCalledOnce()
  })

  it('calls onError when a listener callback throws', async () => {
    const onError = vi.fn()
    const adapter = new RedisAdapter({ subscriber, onError })
    adapter.onChange('orders', () => { throw new Error('listener boom') })
    await adapter.connect()

    expect(() => {
      subscriber.handlers.get('message')?.(
        'flux:orders',
        JSON.stringify({ table: 'orders', operation: 'INSERT', newRow: { id: 1 }, oldRow: null }),
      )
    }).not.toThrow()

    expect(onError).toHaveBeenCalledOnce()
  })

  it('connect() is idempotent', async () => {
    const adapter = new RedisAdapter({ subscriber })
    await adapter.connect()
    await adapter.connect()
    expect(subscriber.on).toHaveBeenCalledTimes(3) // message + error + ready — once total
  })
})

// ── RedisPublisher ────────────────────────────────────────────────────────────

describe('RedisPublisher', () => {
  function makePublishClient() {
    const publishes: Array<{ channel: string; message: string }> = []
    return {
      publishes,
      publish: vi.fn(async (channel: string, message: string) => {
        publishes.push({ channel, message })
        return 1
      }),
    }
  }

  it('publishInsert sends INSERT payload on correct channel', async () => {
    const client = makePublishClient()
    const pub = new RedisPublisher({ client, channelPrefix: 'app' })
    await pub.publishInsert('messages', { id: 1, content: 'hello' })

    expect(client.publishes).toHaveLength(1)
    expect(client.publishes[0]!.channel).toBe('app:messages')

    const payload = JSON.parse(client.publishes[0]!.message)
    expect(payload).toMatchObject({
      table: 'messages',
      operation: 'INSERT',
      newRow: { id: 1, content: 'hello' },
      oldRow: null,
    })
    expect(typeof payload.timestamp).toBe('number')
  })

  it('publishUpdate sends UPDATE payload with newRow and oldRow', async () => {
    const client = makePublishClient()
    const pub = new RedisPublisher({ client })
    const oldRow = { id: 5, status: 'pending' }
    const newRow = { id: 5, status: 'done' }
    await pub.publishUpdate('orders', newRow, oldRow)

    const payload = JSON.parse(client.publishes[0]!.message)
    expect(payload.operation).toBe('UPDATE')
    expect(payload.newRow).toEqual(newRow)
    expect(payload.oldRow).toEqual(oldRow)
    expect(client.publishes[0]!.channel).toBe('flux:orders')
  })

  it('publishDelete sends DELETE payload with oldRow', async () => {
    const client = makePublishClient()
    const pub = new RedisPublisher({ client })
    await pub.publishDelete('messages', { id: 42, content: 'bye' })

    const payload = JSON.parse(client.publishes[0]!.message)
    expect(payload.operation).toBe('DELETE')
    expect(payload.newRow).toBeNull()
    expect(payload.oldRow).toEqual({ id: 42, content: 'bye' })
  })

  it('publishUpdate with null oldRow is allowed', async () => {
    const client = makePublishClient()
    const pub = new RedisPublisher({ client })
    await pub.publishUpdate('items', { id: 1, name: 'updated' })

    const payload = JSON.parse(client.publishes[0]!.message)
    expect(payload.oldRow).toBeNull()
  })

  it('uses default channelPrefix "flux" when not specified', async () => {
    const client = makePublishClient()
    const pub = new RedisPublisher({ client })
    await pub.publishInsert('items', { id: 1 })
    expect(client.publishes[0]!.channel).toBe('flux:items')
  })

  it('publish() includes table and auto-generated timestamp', async () => {
    const client = makePublishClient()
    const pub = new RedisPublisher({ client, channelPrefix: 'test' })
    const before = Date.now()
    await pub.publish('orders', { operation: 'INSERT', newRow: { id: 1 }, oldRow: null })
    const after = Date.now()

    const payload = JSON.parse(client.publishes[0]!.message)
    expect(payload.table).toBe('orders')
    expect(payload.timestamp).toBeGreaterThanOrEqual(before)
    expect(payload.timestamp).toBeLessThanOrEqual(after)
  })

  it('publisher payload is parseable by RedisAdapter', async () => {
    // End-to-end: publisher emits → adapter receives
    const sub = makeSubscriber()
    const adapter = new RedisAdapter({ subscriber: sub, channelPrefix: 'e2e' })
    const received: any[] = []
    adapter.onChange('orders', (e) => received.push(e))
    await adapter.connect()

    const client = makePublishClient()
    const pub = new RedisPublisher({ client, channelPrefix: 'e2e' })
    await pub.publishInsert('orders', { id: 99, total: 50 })

    // Replay the published message through the adapter's message handler
    const { channel, message } = client.publishes[0]!
    sub.handlers.get('message')?.(channel, message)

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      table: 'orders', operation: 'INSERT',
      newRow: { id: 99, total: 50 }, oldRow: null,
    })
  })
})
