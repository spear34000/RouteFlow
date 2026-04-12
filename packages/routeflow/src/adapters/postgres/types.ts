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
}
