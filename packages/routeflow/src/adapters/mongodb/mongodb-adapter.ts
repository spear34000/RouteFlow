import type { ChangeEvent, DatabaseAdapter } from '../../core/types.js'
import { ReactiveApiError } from '../../core/errors.js'
import type {
  MongoAdapterOptions,
  MongoChangeStreamDocument,
  MongoCollectionState,
} from './types.js'

/**
 * MongoDB adapter for RouteFlow.
 *
 * The adapter expects a MongoDB driver's `Db`-compatible object and opens
 * one Change Stream per watched collection.
 */
export class MongoDbAdapter implements DatabaseAdapter {
  private readonly db: MongoAdapterOptions['db']
  private readonly watchOptions: Record<string, unknown>
  private readonly onError?: MongoAdapterOptions['onError']
  private readonly collections: Map<string, MongoCollectionState> = new Map()
  private connected = false

  constructor(options: MongoAdapterOptions) {
    this.db = options.db
    this.watchOptions = {
      fullDocument: 'updateLookup',
      fullDocumentBeforeChange: 'whenAvailable',
      ...options.watchOptions,
    }
    this.onError = options.onError
  }

  async connect(): Promise<void> {
    this.connected = true

    for (const collection of this.collections.keys()) {
      this.ensureCollectionStream(collection)
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false

    await Promise.all(
      Array.from(this.collections.values(), async (state) => {
        await state.stream.close()
      }),
    )
  }

  onChange(collection: string, callback: (event: ChangeEvent) => void): () => void {
    const state = this.collections.get(collection)
    if (state) {
      state.listeners.add(callback)
    } else {
      this.collections.set(collection, {
        stream: null as never,
        listeners: new Set([callback]),
      })
    }

    this.ensureCollectionStream(collection)

    return () => {
      const current = this.collections.get(collection)
      if (!current) return

      current.listeners.delete(callback)

      if (current.listeners.size === 0) {
        void current.stream?.close()
        this.collections.delete(collection)
      }
    }
  }

  private ensureCollectionStream(collection: string): void {
    if (!this.connected) return

    const state = this.collections.get(collection)
    if (!state || state.stream) return

    try {
      const stream = this.db.collection(collection).watch([], this.watchOptions)
      stream.on('change', (change) => {
        this.handleChange(collection, change)
      })
      stream.on('error', (error) => {
        this.onError?.(error, { collection })
      })
      state.stream = stream
    } catch (error) {
      throw new ReactiveApiError(
        'MONGODB_STREAM_FAILED',
        `Failed to open MongoDB change stream for "${collection}": ${errorMessage(error)}`,
      )
    }
  }

  private handleChange(
    collection: string,
    change: MongoChangeStreamDocument<Record<string, unknown>>,
  ): void {
    const event = mapMongoChangeToEvent(collection, change)
    if (!event) return

    const state = this.collections.get(collection)
    if (!state) return

    for (const listener of state.listeners) {
      listener(event)
    }
  }
}

function mapMongoChangeToEvent(
  collection: string,
  change: MongoChangeStreamDocument<Record<string, unknown>>,
): ChangeEvent | null {
  const timestamp = Date.now()

  switch (change.operationType) {
    case 'insert':
      return {
        table: collection,
        operation: 'INSERT',
        newRow: change.fullDocument ?? null,
        oldRow: null,
        timestamp,
      }
    case 'replace':
    case 'update':
      return {
        table: collection,
        operation: 'UPDATE',
        newRow: change.fullDocument ?? null,
        oldRow: change.fullDocumentBeforeChange ?? null,
        timestamp,
      }
    case 'delete':
      return {
        table: collection,
        operation: 'DELETE',
        newRow: null,
        oldRow:
          change.fullDocumentBeforeChange ??
          (change.documentKey ? { _id: change.documentKey._id } : null),
        timestamp,
      }
    default:
      return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
