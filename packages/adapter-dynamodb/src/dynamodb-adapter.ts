import type { ChangeEvent, DatabaseAdapter } from '@spear340000/core'
import { ReactiveApiError } from '@spear340000/core'
import type {
  DynamoDbAdapterOptions,
  DynamoDbAttributeMap,
  DynamoDbStreamRecord,
  DynamoDbStreamSource,
  NormalisedDynamoDbRecord,
} from './types.js'

/**
 * DynamoDB adapter for RouteFlow.
 *
 * Consumes DynamoDB Streams-style records from an external source.
 */
export class DynamoDbAdapter implements DatabaseAdapter {
  private readonly source: DynamoDbStreamSource
  private readonly unmarshall: NonNullable<DynamoDbAdapterOptions['unmarshall']>
  private readonly onError?: DynamoDbAdapterOptions['onError']
  private readonly listeners: Map<string, Set<(event: ChangeEvent) => void>> = new Map()
  private readonly handleRecordBound = (record: DynamoDbStreamRecord) => {
    this.handleRecord(record)
  }
  private readonly handleErrorBound = (error: Error) => {
    this.onError?.(error)
  }
  private connected = false

  constructor(options: DynamoDbAdapterOptions) {
    this.source = options.source
    this.unmarshall = options.unmarshall ?? defaultUnmarshall
    this.onError = options.onError
  }

  async connect(): Promise<void> {
    if (this.connected) return

    this.source.on('record', this.handleRecordBound)
    this.source.on('error', this.handleErrorBound)

    try {
      await this.source.start?.()
    } catch (error) {
      throw new ReactiveApiError(
        'DYNAMODB_STREAM_START_FAILED',
        `Failed to start DynamoDB stream source: ${errorMessage(error)}`,
      )
    }

    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return

    removeListener(this.source, 'record', this.handleRecordBound)
    removeListener(this.source, 'error', this.handleErrorBound)
    await this.source.stop?.()
    this.listeners.clear()
    this.connected = false
  }

  onChange(table: string, callback: (event: ChangeEvent) => void): () => void {
    if (!this.listeners.has(table)) {
      this.listeners.set(table, new Set())
    }

    this.listeners.get(table)!.add(callback)

    return () => {
      const callbacks = this.listeners.get(table)
      if (!callbacks) return

      callbacks.delete(callback)
      if (callbacks.size === 0) {
        this.listeners.delete(table)
      }
    }
  }

  private handleRecord(record: DynamoDbStreamRecord): void {
    const normalised = normaliseRecord(record, this.unmarshall)
    if (!normalised) return

    const callbacks = this.listeners.get(normalised.table)
    if (!callbacks) return

    const event: ChangeEvent = {
      ...normalised,
      timestamp: Date.now(),
    }

    for (const callback of callbacks) {
      callback(event)
    }
  }
}

function normaliseRecord(
  record: DynamoDbStreamRecord,
  unmarshall: (image: DynamoDbAttributeMap | undefined) => Record<string, unknown> | null,
): NormalisedDynamoDbRecord | null {
  const table = extractTableName(record.eventSourceARN)
  if (!table || !record.eventName) return null

  if (record.eventName === 'INSERT') {
    return {
      table,
      operation: 'INSERT',
      newRow: unmarshall(record.dynamodb?.NewImage),
      oldRow: null,
    }
  }

  if (record.eventName === 'MODIFY') {
    return {
      table,
      operation: 'UPDATE',
      newRow: unmarshall(record.dynamodb?.NewImage),
      oldRow: unmarshall(record.dynamodb?.OldImage),
    }
  }

  if (record.eventName === 'REMOVE') {
    return {
      table,
      operation: 'DELETE',
      newRow: null,
      oldRow: unmarshall(record.dynamodb?.OldImage),
    }
  }

  return null
}

function extractTableName(arn: string | undefined): string | null {
  if (!arn) return null
  const match = arn.match(/table\/([^/]+)/)
  return match?.[1] ?? null
}

function defaultUnmarshall(
  image: DynamoDbAttributeMap | undefined,
): Record<string, unknown> | null {
  if (!image) return null

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(image)) {
    result[key] = decodeAttributeValue(value)
  }
  return result
}

function decodeAttributeValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value

  const record = value as Record<string, unknown>
  if ('S' in record) return record['S']
  if ('N' in record) return Number(record['N'])
  if ('BOOL' in record) return record['BOOL']
  if ('NULL' in record) return null
  if ('M' in record && typeof record['M'] === 'object' && record['M'] !== null) {
    return defaultUnmarshall(record['M'] as DynamoDbAttributeMap)
  }
  if ('L' in record && Array.isArray(record['L'])) {
    return record['L'].map((item) => decodeAttributeValue(item))
  }
  if ('SS' in record) return record['SS']
  if ('NS' in record) return Array.isArray(record['NS']) ? record['NS'].map(Number) : record['NS']

  return value
}

function removeListener(
  source: DynamoDbStreamSource,
  event: 'record' | 'error',
  listener: (...args: any[]) => void,
): void {
  if (source.off) {
    source.off(event, listener)
    return
  }

  source.removeListener?.(event, listener)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
