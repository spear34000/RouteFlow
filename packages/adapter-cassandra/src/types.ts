import type { ChangeEvent } from '@routeflow/core'

export interface CassandraCdcEvent<T = unknown> {
  table: string
  operation: ChangeEvent<T>['operation']
  newRow: T | null
  oldRow: T | null
  timestamp?: number
}

export interface CassandraCdcSource {
  on(event: 'change', listener: (event: CassandraCdcEvent) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  off?(event: 'change' | 'error', listener: (...args: any[]) => void): void
  removeListener?(event: 'change' | 'error', listener: (...args: any[]) => void): void
  start?(): Promise<void> | void
  stop?(): Promise<void> | void
}

export interface CassandraAdapterOptions {
  source: CassandraCdcSource
  onError?: (error: unknown) => void
}
