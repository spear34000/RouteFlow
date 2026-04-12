import type { ChangeEvent } from '../../core/types.js'

export interface ElasticsearchChangeSource {
  on(event: 'change', listener: (change: ElasticsearchSourceEvent) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  off?(event: 'change' | 'error', listener: (...args: any[]) => void): void
  removeListener?(event: 'change' | 'error', listener: (...args: any[]) => void): void
  start?(): Promise<void> | void
  stop?(): Promise<void> | void
}

export interface ElasticsearchSourceEvent<T = unknown> {
  index: string
  operation: ChangeEvent<T>['operation']
  newDocument: T | null
  oldDocument: T | null
  timestamp?: number
}

export interface ElasticsearchAdapterOptions {
  source: ElasticsearchChangeSource
  onError?: (error: unknown) => void
}
