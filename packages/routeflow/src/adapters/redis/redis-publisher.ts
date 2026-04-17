import type { RedisChangePayload, RedisPublisherClient, RedisPublisherOptions } from './types.js'

/**
 * Publishes RouteFlow change events to Redis pub/sub channels.
 *
 * Use this on the **write** side of your application (e.g. after a DB mutation)
 * to notify all RouteFlow WebSocket subscribers of the change.
 *
 * The channel name format must match the `channelPrefix` configured in `RedisAdapter`.
 *
 * @example
 * ```ts
 * import { RedisPublisher } from 'routeflow-api/adapters/redis'
 * import Redis from 'ioredis'
 *
 * const redis = new Redis()
 * const publisher = new RedisPublisher({ client: redis, channelPrefix: 'myapp' })
 *
 * // After inserting a new message:
 * await publisher.publishInsert('messages', { id: 101, roomId: 1, content: 'Hello!' })
 *
 * // After updating a record:
 * await publisher.publishUpdate('orders', updatedOrder, previousOrder)
 *
 * // After deleting a record:
 * await publisher.publishDelete('messages', { id: 101, roomId: 1, content: 'Hello!' })
 * ```
 */
export class RedisPublisher {
  private readonly client: RedisPublisherClient
  private readonly channelPrefix: string

  constructor(options: RedisPublisherOptions) {
    this.client = options.client
    this.channelPrefix = options.channelPrefix ?? 'flux'
  }

  /**
   * Publish a raw change event.
   *
   * @param table  - Table (or resource) name. Must match the table name used in `app.flow()`.
   * @param payload - Change payload without `table` or `timestamp` (filled automatically).
   */
  async publish<T = unknown>(
    table: string,
    payload: Omit<RedisChangePayload<T>, 'table' | 'timestamp'>,
  ): Promise<void> {
    const message: RedisChangePayload<T> = {
      ...payload,
      table,
      timestamp: Date.now(),
    }
    await this.client.publish(
      channelName(this.channelPrefix, table),
      JSON.stringify(message),
    )
  }

  /**
   * Publish an INSERT event for a newly created row.
   *
   * @example
   * ```ts
   * const created = await db.insert(messages).values({ roomId: 1, content: 'hi' }).returning()
   * await publisher.publishInsert('messages', created[0])
   * ```
   */
  async publishInsert<T = unknown>(table: string, row: T): Promise<void> {
    return this.publish<T>(table, { operation: 'INSERT', newRow: row, oldRow: null })
  }

  /**
   * Publish an UPDATE event for a modified row.
   *
   * @param table   - Table name.
   * @param newRow  - Row after the update.
   * @param oldRow  - Row before the update (pass `null` if unavailable).
   *
   * @example
   * ```ts
   * await publisher.publishUpdate('orders', updatedOrder, previousOrder)
   * ```
   */
  async publishUpdate<T = unknown>(table: string, newRow: T, oldRow: T | null = null): Promise<void> {
    return this.publish<T>(table, { operation: 'UPDATE', newRow, oldRow })
  }

  /**
   * Publish a DELETE event for a removed row.
   *
   * @example
   * ```ts
   * await publisher.publishDelete('messages', { id: 101, roomId: 1, content: 'hi' })
   * ```
   */
  async publishDelete<T = unknown>(table: string, row: T): Promise<void> {
    return this.publish<T>(table, { operation: 'DELETE', newRow: null, oldRow: row })
  }
}

function channelName(prefix: string, table: string): string {
  return `${prefix}:${table}`
}
