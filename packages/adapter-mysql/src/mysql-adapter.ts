import type { ChangeEvent, DatabaseAdapter } from '@routeflow/core'
import { ReactiveApiError } from '@routeflow/core'
import type {
  MySqlAdapterOptions,
  MySqlBinlogEvent,
  MySqlBinlogSource,
  NormalisedMySqlChange,
} from './types.js'

/**
 * MySQL adapter for RouteFlow.
 *
 * It consumes a binlog event source compatible with libraries such as ZongJi.
 */
export class MySqlAdapter implements DatabaseAdapter {
  private readonly source: MySqlBinlogSource
  private readonly schema?: string
  private readonly startOptions?: Record<string, unknown>
  private readonly onError?: (error: unknown) => void
  private readonly listeners: Map<string, Set<(event: ChangeEvent) => void>> = new Map()
  private readonly handleBinlogBound = (event: MySqlBinlogEvent) => {
    this.handleBinlog(event)
  }
  private readonly handleErrorBound = (error: Error) => {
    this.onError?.(error)
  }
  private connected = false

  constructor(options: MySqlAdapterOptions) {
    this.source = options.source
    this.schema = options.schema
    this.startOptions = options.startOptions
    this.onError = options.onError
  }

  async connect(): Promise<void> {
    if (this.connected) return

    this.source.on('binlog', this.handleBinlogBound)
    this.source.on('error', this.handleErrorBound)

    try {
      await this.source.start?.(this.startOptions)
    } catch (error) {
      throw new ReactiveApiError(
        'MYSQL_BINLOG_START_FAILED',
        `Failed to start MySQL binlog source: ${errorMessage(error)}`,
      )
    }

    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return

    removeListener(this.source, 'binlog', this.handleBinlogBound)
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

  private handleBinlog(event: MySqlBinlogEvent): void {
    const changes = normaliseBinlogEvent(event)
    if (changes.length === 0) return

    for (const change of changes) {
      if (this.schema && readSchemaName(event) !== this.schema) continue

      const callbacks = this.listeners.get(change.table)
      if (!callbacks) continue

      const fluxEvent: ChangeEvent = {
        ...change,
        timestamp: Date.now(),
      }

      for (const callback of callbacks) {
        callback(fluxEvent)
      }
    }
  }
}

function normaliseBinlogEvent(event: MySqlBinlogEvent): NormalisedMySqlChange[] {
  const typeName = event.getTypeName?.().toLowerCase() ?? ''
  const table = event.tableMap?.tableName
  if (!table) return []

  if (typeName.includes('write')) {
    return event.rows.map((row) => ({
      table,
      operation: 'INSERT',
      newRow: row,
      oldRow: null,
    }))
  }

  if (typeName.includes('delete')) {
    return event.rows.map((row) => ({
      table,
      operation: 'DELETE',
      newRow: null,
      oldRow: row,
    }))
  }

  if (typeName.includes('update')) {
    return event.rows.map((row) => ({
      table,
      operation: 'UPDATE',
      newRow: row.after,
      oldRow: row.before,
    }))
  }

  return []
}

function readSchemaName(event: MySqlBinlogEvent): string | undefined {
  return event.tableMap?.parentSchema ?? event.tableMap?.schemaName
}

function removeListener(
  source: MySqlBinlogSource,
  event: 'binlog' | 'error',
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
