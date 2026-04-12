import type { ChangeEvent } from '../../core/types.js'

export interface SnowflakeChangeEvent<T = unknown> {
  table: string
  operation: ChangeEvent<T>['operation']
  newRow: T | null
  oldRow: T | null
  timestamp?: number
}

export interface SnowflakeChangeSource {
  on(event: 'change', listener: (event: SnowflakeChangeEvent) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  off?(event: 'change' | 'error', listener: (...args: any[]) => void): void
  removeListener?(event: 'change' | 'error', listener: (...args: any[]) => void): void
  start?(): Promise<void> | void
  stop?(): Promise<void> | void
}

export interface SnowflakeAdapterOptions {
  source: SnowflakeChangeSource
  onError?: (error: unknown) => void
}
