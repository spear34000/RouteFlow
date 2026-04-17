/**
 * Configuration options for PostgresAdapter.
 */
export interface PostgresAdapterOptions {
  /**
   * PostgreSQL connection string.
   * e.g. 'postgresql://user:password@localhost:5432/dbname'
   */
  connectionString: string

  /**
   * Schema to install trigger functions in.
   * Defaults to 'public'.
   */
  schema?: string

  /**
   * Name prefix for generated trigger functions and triggers.
   * Defaults to 'reactive_api'.
   */
  triggerPrefix?: string

  /**
   * Called on connection errors, trigger installation failures, and listener errors.
   * When omitted, errors are logged to `console.error`.
   */
  onError?: (error: Error) => void

  /**
   * Maximum number of automatic reconnect attempts after an unexpected disconnect.
   * Set to `0` to disable auto-reconnect.
   * Default: 10.
   */
  maxReconnectAttempts?: number

  /**
   * Initial reconnect backoff in milliseconds. Doubles on each failure (capped at 30 s).
   * Default: 500.
   */
  reconnectDelayMs?: number
}

/**
 * The raw JSON payload delivered by the PostgreSQL NOTIFY.
 * Must stay in sync with the trigger function SQL in trigger-sql.ts.
 */
export interface NotifyPayload {
  table: string
  operation: 'INSERT' | 'UPDATE' | 'DELETE'
  new_row: Record<string, unknown> | null
  old_row: Record<string, unknown> | null
  /** Server-side timestamp (ms since epoch) from clock_timestamp(). */
  event_time?: number
  /** True when the payload exceeded 7900 bytes and row data was omitted. */
  _truncated?: boolean
}
