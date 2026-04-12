import type { ChangeEvent } from '../../core/types.js'

export interface DynamoDbAttributeMap {
  [key: string]: unknown
}

export interface DynamoDbStreamRecord {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE'
  dynamodb?: {
    NewImage?: DynamoDbAttributeMap
    OldImage?: DynamoDbAttributeMap
  }
  eventSourceARN?: string
}

export interface DynamoDbStreamSource {
  on(event: 'record', listener: (record: DynamoDbStreamRecord) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  off?(event: 'record' | 'error', listener: (...args: any[]) => void): void
  removeListener?(event: 'record' | 'error', listener: (...args: any[]) => void): void
  start?(): Promise<void> | void
  stop?(): Promise<void> | void
}

export interface DynamoDbAdapterOptions {
  source: DynamoDbStreamSource
  unmarshall?: (image: DynamoDbAttributeMap | undefined) => Record<string, unknown> | null
  onError?: (error: unknown) => void
}

export interface NormalisedDynamoDbRecord<T = unknown> {
  table: string
  operation: ChangeEvent<T>['operation']
  newRow: T | null
  oldRow: T | null
}
