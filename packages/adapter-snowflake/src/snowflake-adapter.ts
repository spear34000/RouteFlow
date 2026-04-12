import type { ChangeEvent, DatabaseAdapter } from '@spear340000/core'
import { ReactiveApiError } from '@spear340000/core'
import type {
  SnowflakeAdapterOptions,
  SnowflakeChangeEvent,
  SnowflakeChangeSource,
} from './types.js'

export class SnowflakeAdapter implements DatabaseAdapter {
  private readonly source: SnowflakeChangeSource
  private readonly onError?: SnowflakeAdapterOptions['onError']
  private readonly listeners: Map<string, Set<(event: ChangeEvent) => void>> = new Map()
  private readonly handleChangeBound = (event: SnowflakeChangeEvent) => {
    this.handleChange(event)
  }
  private readonly handleErrorBound = (error: Error) => {
    this.onError?.(error)
  }
  private connected = false

  constructor(options: SnowflakeAdapterOptions) {
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
        'SNOWFLAKE_SOURCE_START_FAILED',
        `Failed to start Snowflake change source: ${errorMessage(error)}`,
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

  private handleChange(change: SnowflakeChangeEvent): void {
    const callbacks = this.listeners.get(change.table)
    if (!callbacks) return

    const event: ChangeEvent = {
      ...change,
      timestamp: change.timestamp ?? Date.now(),
    }

    for (const callback of callbacks) {
      callback(event)
    }
  }
}

function removeListener(
  source: SnowflakeChangeSource,
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
