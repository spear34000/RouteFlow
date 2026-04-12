import type { ChangeEvent } from '../../core/types.js'

export interface RedisSubscriber {
  subscribe(channel: string): Promise<void> | void
  unsubscribe(channel: string): Promise<void> | void
  on(event: 'message', listener: (channel: string, payload: string) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  off?(event: 'message' | 'error', listener: (...args: any[]) => void): void
  removeListener?(event: 'message' | 'error', listener: (...args: any[]) => void): void
  quit?(): Promise<void> | void
  disconnect?(): Promise<void> | void
}

export interface RedisAdapterOptions {
  subscriber: RedisSubscriber
  channelPrefix?: string
  onError?: (error: unknown) => void
}

export interface RedisChangePayload<T = unknown> {
  table: string
  operation: ChangeEvent<T>['operation']
  newRow: T | null
  oldRow: T | null
  timestamp?: number
}
