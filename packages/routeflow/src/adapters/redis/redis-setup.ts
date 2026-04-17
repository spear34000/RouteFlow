/**
 * createRedisAdapter — convenience factory that creates a matched
 * RedisAdapter + RedisPublisher pair with a shared channelPrefix.
 *
 * Before:
 * ```ts
 * const adapter   = new RedisAdapter({ subscriber: redis1, channelPrefix: 'app' })
 * const publisher = new RedisPublisher({ client: redis2,   channelPrefix: 'app' })
 * ```
 *
 * After:
 * ```ts
 * const { adapter, publisher } = createRedisAdapter({
 *   subscriber: new Redis(),
 *   publisher:  new Redis(),
 *   channelPrefix: 'app',
 * })
 * ```
 */

import { RedisAdapter } from './redis-adapter.js'
import { RedisPublisher } from './redis-publisher.js'
import type { RedisSubscriber, RedisPublisherClient } from './types.js'

export interface CreateRedisAdapterOptions {
  /** ioredis (or compatible) instance used for SUBSCRIBE. */
  subscriber: RedisSubscriber
  /** ioredis (or compatible) instance used for PUBLISH. */
  publisher: RedisPublisherClient
  /** Channel prefix. Defaults to 'flux'. Both adapter and publisher share this value. */
  channelPrefix?: string
  /** Called when a subscriber error or oversized payload is encountered. */
  onError?: (error: unknown) => void
}

export interface CreateRedisAdapterResult {
  /** DatabaseAdapter for use with createApp() or flow(). */
  adapter: RedisAdapter
  /** Publisher helpers: publishInsert / publishUpdate / publishDelete / publish. */
  publisher: RedisPublisher
}

/**
 * Create a matched RedisAdapter + RedisPublisher pair.
 *
 * Pass two separate ioredis connections — one for SUBSCRIBE, one for PUBLISH —
 * as Redis does not allow both modes on the same connection.
 *
 * @example
 * ```ts
 * import Redis from 'ioredis'
 * import { createRedisAdapter, createApp } from 'routeflow-api'
 *
 * const { adapter, publisher } = createRedisAdapter({
 *   subscriber:    new Redis(REDIS_URL),
 *   publisher:     new Redis(REDIS_URL),
 *   channelPrefix: 'myapp',
 * })
 *
 * await publisher.publishInsert('orders', { id: 1, total: 99 })
 *
 * createApp({ adapter, port: 3000 }).flow('/orders', orders).listen()
 * ```
 */
export function createRedisAdapter(opts: CreateRedisAdapterOptions): CreateRedisAdapterResult {
  const { subscriber, publisher: publisherClient, channelPrefix, onError } = opts

  const adapter = new RedisAdapter({
    subscriber,
    channelPrefix,
    onError,
  })

  const publisher = new RedisPublisher({
    client: publisherClient,
    channelPrefix,
  })

  return { adapter, publisher }
}
