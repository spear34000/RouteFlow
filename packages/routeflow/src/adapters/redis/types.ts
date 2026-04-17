import type { ChangeEvent } from '../../core/types.js'

export interface RedisSubscriber {
  subscribe(channel: string): Promise<void> | void
  unsubscribe(channel: string): Promise<void> | void
  on(event: 'message', listener: (channel: string, payload: string) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  /** Emitted by ioredis / node-redis after a successful (re)connection. */
  on(event: 'ready', listener: () => void): void
  off?(event: 'message' | 'error' | 'ready', listener: (...args: any[]) => void): void
  removeListener?(event: 'message' | 'error' | 'ready', listener: (...args: any[]) => void): void
  quit?(): Promise<void> | void
  disconnect?(): Promise<void> | void
}

/** Minimal Redis client interface for publishing change events. */
export interface RedisPublisherClient {
  /**
   * Publish a message to a channel.
   * Compatible with ioredis `publish()` and node-redis `publish()`.
   */
  publish(channel: string, message: string): Promise<number | void> | void
}

export interface RedisAdapterOptions {
  subscriber: RedisSubscriber
  channelPrefix?: string
  onError?: (error: unknown) => void
}

export interface RedisPublisherOptions {
  /** Redis client capable of publishing (not the subscribe-mode client). */
  client: RedisPublisherClient
  /** Channel prefix. Must match the RedisAdapter's channelPrefix. Default: 'flux'. */
  channelPrefix?: string
}

export interface RedisChangePayload<T = unknown> {
  table: string
  operation: ChangeEvent<T>['operation']
  newRow: T | null
  oldRow: T | null
  timestamp?: number
}
