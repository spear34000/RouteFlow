import type { ChangeEvent } from '../../core/types.js'

export interface MySqlBinlogTableMap {
  parentSchema?: string
  schemaName?: string
  tableName?: string
}

export interface MySqlWriteRowsEvent {
  getTypeName?: () => string
  tableMap?: MySqlBinlogTableMap
  rows: Array<Record<string, unknown>>
}

export interface MySqlDeleteRowsEvent {
  getTypeName?: () => string
  tableMap?: MySqlBinlogTableMap
  rows: Array<Record<string, unknown>>
}

export interface MySqlUpdateRowsEvent {
  getTypeName?: () => string
  tableMap?: MySqlBinlogTableMap
  rows: Array<{
    before: Record<string, unknown>
    after: Record<string, unknown>
  }>
}

export type MySqlBinlogEvent =
  | MySqlWriteRowsEvent
  | MySqlDeleteRowsEvent
  | MySqlUpdateRowsEvent

export interface MySqlBinlogSource {
  on(event: 'binlog', listener: (event: MySqlBinlogEvent) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  off?(event: 'binlog' | 'error', listener: (...args: any[]) => void): void
  removeListener?(event: 'binlog' | 'error', listener: (...args: any[]) => void): void
  start?(options?: Record<string, unknown>): Promise<void> | void
  stop?(): Promise<void> | void
}

export interface MySqlAdapterOptions {
  source: MySqlBinlogSource
  schema?: string
  startOptions?: Record<string, unknown>
  onError?: (error: unknown) => void
}

export type NormalisedMySqlChange = Omit<ChangeEvent, 'table' | 'timestamp'> & { table: string }
