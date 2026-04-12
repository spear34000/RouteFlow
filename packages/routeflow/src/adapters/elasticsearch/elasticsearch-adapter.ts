import type { ChangeEvent, DatabaseAdapter } from '../../core/types.js'
import { ReactiveApiError } from '../../core/errors.js'
import type {
  ElasticsearchAdapterOptions,
  ElasticsearchChangeSource,
  ElasticsearchSourceEvent,
} from './types.js'

/**
 * Elasticsearch adapter for RouteFlow.
 *
 * Elasticsearch does not provide a built-in change stream, so this adapter
 * consumes an external source that emits index-level change events.
 */
export class ElasticsearchAdapter implements DatabaseAdapter {
  private readonly source: ElasticsearchChangeSource
  private readonly onError?: ElasticsearchAdapterOptions['onError']
  private readonly listeners: Map<string, Set<(event: ChangeEvent) => void>> = new Map()
  private readonly handleChangeBound = (change: ElasticsearchSourceEvent) => {
    this.handleChange(change)
  }
  private readonly handleErrorBound = (error: Error) => {
    this.onError?.(error)
  }
  private connected = false

  constructor(options: ElasticsearchAdapterOptions) {
    this.source = options.source
    this.onError = options.onError
  }

  async connect(): Promise<void> {
    if (this.connected) return

    this.source.on('change', this.handleChangeBound)
    this.source.on('error', this.handleErrorBound)

    try {
      await this.source.start?.()
    } catch (error) {
      throw new ReactiveApiError(
        'ELASTICSEARCH_SOURCE_START_FAILED',
        `Failed to start Elasticsearch change source: ${errorMessage(error)}`,
      )
    }

    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return

    removeListener(this.source, 'change', this.handleChangeBound)
    removeListener(this.source, 'error', this.handleErrorBound)
    await this.source.stop?.()
    this.listeners.clear()
    this.connected = false
  }

  onChange(index: string, callback: (event: ChangeEvent) => void): () => void {
    if (!this.listeners.has(index)) {
      this.listeners.set(index, new Set())
    }

    this.listeners.get(index)!.add(callback)

    return () => {
      const callbacks = this.listeners.get(index)
      if (!callbacks) return

      callbacks.delete(callback)
      if (callbacks.size === 0) {
        this.listeners.delete(index)
      }
    }
  }

  private handleChange(change: ElasticsearchSourceEvent): void {
    const callbacks = this.listeners.get(change.index)
    if (!callbacks) return

    const event: ChangeEvent = {
      table: change.index,
      operation: change.operation,
      newRow: change.newDocument,
      oldRow: change.oldDocument,
      timestamp: change.timestamp ?? Date.now(),
    }

    for (const callback of callbacks) {
      callback(event)
    }
  }
}

function removeListener(
  source: ElasticsearchChangeSource,
  event: 'change' | 'error',
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
