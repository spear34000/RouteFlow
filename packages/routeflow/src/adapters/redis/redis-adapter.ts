import type { ChangeEvent, DatabaseAdapter } from '../../core/types.js'
import type { RedisAdapterOptions, RedisChangePayload, RedisSubscriber } from './types.js'

/**
 * Redis adapter for RouteFlow.
 *
 * Each watched table maps to one Redis pub/sub channel. Publishers are expected
 * to publish JSON payloads in the RouteFlow change-event shape.
 */
export class RedisAdapter implements DatabaseAdapter {
  private readonly subscriber: RedisSubscriber
  private readonly channelPrefix: string
  private readonly onError?: RedisAdapterOptions['onError']
  private readonly listeners: Map<string, Set<(event: ChangeEvent) => void>> = new Map()
  private readonly handleMessageBound = (channel: string, payload: string) => {
    this.handleMessage(channel, payload)
  }
  private readonly handleErrorBound = (error: Error) => {
    this.onError?.(error)
  }
  private connected = false

  constructor(options: RedisAdapterOptions) {
    this.subscriber = options.subscriber
    this.channelPrefix = options.channelPrefix ?? 'flux'
    this.onError = options.onError
  }

  async connect(): Promise<void> {
    if (this.connected) return

    this.subscriber.on('message', this.handleMessageBound)
    this.subscriber.on('error', this.handleErrorBound)

    for (const table of this.listeners.keys()) {
      await this.subscriber.subscribe(channelName(this.channelPrefix, table))
    }

    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return

    removeListener(this.subscriber, 'message', this.handleMessageBound)
    removeListener(this.subscriber, 'error', this.handleErrorBound)

    for (const table of this.listeners.keys()) {
      await this.subscriber.unsubscribe(channelName(this.channelPrefix, table))
    }

    await this.subscriber.quit?.()
    await this.subscriber.disconnect?.()
    this.listeners.clear()
    this.connected = false
  }

  onChange(table: string, callback: (event: ChangeEvent) => void): () => void {
    const hadTable = this.listeners.has(table)
    if (!hadTable) {
      this.listeners.set(table, new Set())
    }

    this.listeners.get(table)!.add(callback)

    if (!hadTable && this.connected) {
      void this.subscriber.subscribe(channelName(this.channelPrefix, table))
    }

    return () => {
      const callbacks = this.listeners.get(table)
      if (!callbacks) return

      callbacks.delete(callback)
      if (callbacks.size === 0) {
        this.listeners.delete(table)
        if (this.connected) {
          void this.subscriber.unsubscribe(channelName(this.channelPrefix, table))
        }
      }
    }
  }

  /** Maximum accepted Redis message size (1 MiB). Larger payloads are dropped. */
  private static readonly MAX_PAYLOAD_BYTES = 1 * 1024 * 1024

  private handleMessage(channel: string, payload: string): void {
    const table = parseChannelName(this.channelPrefix, channel)
    if (!table) return

    // Guard against oversized payloads before JSON-parsing.
    if (payload.length > RedisAdapter.MAX_PAYLOAD_BYTES) {
      const msg = `[RouteFlow/redis] Dropping oversized message on channel "${channel}" (${payload.length} bytes > ${RedisAdapter.MAX_PAYLOAD_BYTES})`
      console.warn(msg)
      this.onError?.(new Error(msg))
      return
    }

    let data: unknown
    try {
      data = JSON.parse(payload)
    } catch (error) {
      // Never throw inside an event-listener callback — the error would become
      // an unhandled exception.  Emit to onError instead so callers can handle it.
      const msg = `[RouteFlow/redis] Failed to parse payload on channel "${channel}": ${errorMessage(error)}`
      console.error(msg)
      this.onError?.(new Error(msg))
      return
    }

    if (!isRedisChangePayload(data)) return

    const callbacks = this.listeners.get(data.table)
    if (!callbacks) return

    const event: ChangeEvent = {
      table: data.table,
      operation: data.operation,
      newRow: data.newRow,
      oldRow: data.oldRow,
      timestamp: data.timestamp ?? Date.now(),
    }

    for (const callback of callbacks) {
      try {
        callback(event)
      } catch (err) {
        const msg = `[RouteFlow/redis] Listener error on table "${data.table}": ${errorMessage(err)}`
        console.error(msg)
        this.onError?.(new Error(msg))
      }
    }
  }
}

function channelName(prefix: string, table: string): string {
  return `${prefix}:${table}`
}

function parseChannelName(prefix: string, channel: string): string | null {
  const expectedPrefix = `${prefix}:`
  if (!channel.startsWith(expectedPrefix)) return null
  return channel.slice(expectedPrefix.length)
}

function removeListener(
  subscriber: RedisSubscriber,
  event: 'message' | 'error',
  listener: (...args: any[]) => void,
): void {
  if (subscriber.off) {
    subscriber.off(event, listener)
    return
  }

  subscriber.removeListener?.(event, listener)
}

function isRedisChangePayload(value: unknown): value is RedisChangePayload {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['table'] === 'string' &&
    (record['operation'] === 'INSERT' ||
      record['operation'] === 'UPDATE' ||
      record['operation'] === 'DELETE')
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
