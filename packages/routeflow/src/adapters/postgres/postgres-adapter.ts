import { Client, DatabaseError } from 'pg'
import type { ChangeEvent, DatabaseAdapter } from '../../core/types.js'
import { ReactiveApiError } from '../../core/errors.js'
import type { NotifyPayload, PostgresAdapterOptions } from './types.js'
import {
  notifyChannel,
  createTriggerFunctionSQL,
  createTableTriggerSQL,
  dropTableTriggerSQL,
  dropTriggerFunctionSQL,
} from './trigger-sql.js'

/**
 * PostgreSQL database adapter for RouteFlow.
 *
 * Uses a dedicated `pg.Client` (not a pool) for LISTEN so the connection
 * stays open and notifications are never missed. A separate pool/client
 * can still be used by the application for regular queries.
 *
 * Change detection mechanism:
 * - On `onChange(table)`: installs a per-table AFTER INSERT/UPDATE/DELETE trigger
 *   that calls `pg_notify` with a JSON payload.
 * - A single LISTEN connection subscribes to one shared channel for all tables.
 * - Payloads > 7900 bytes are sent without row data (`_truncated: true`);
 *   subscribers receive a ChangeEvent with `newRow: null` / `oldRow: null`.
 *
 * @example
 * ```ts
 * const adapter = new PostgresAdapter({
 *   connectionString: process.env.DATABASE_URL,
 * })
 * await adapter.connect()
 * ```
 */
export class PostgresAdapter implements DatabaseAdapter {
  private listenClient: Client | null = null
  private readonly schema: string
  private readonly prefix: string
  private readonly connectionString: string

  /** table → Set<callback> */
  private readonly listeners: Map<string, Set<(event: ChangeEvent) => void>> = new Map()
  /** Tables for which a trigger has already been installed */
  private readonly installedTriggers: Set<string> = new Set()

  constructor(options: PostgresAdapterOptions) {
    this.connectionString = options.connectionString
    this.schema = options.schema ?? 'public'
    this.prefix = options.triggerPrefix ?? 'reactive_api'
  }

  // ---------------------------------------------------------------------------
  // DatabaseAdapter interface
  // ---------------------------------------------------------------------------

  /** Connect the LISTEN client and install the shared trigger function. */
  async connect(): Promise<void> {
    if (this.listenClient) return

    const client = new Client({ connectionString: this.connectionString })
    try {
      await client.connect()
    } catch (err) {
      throw new ReactiveApiError(
        'POSTGRES_CONNECT_FAILED',
        `Failed to connect to PostgreSQL: ${errorMessage(err)}`,
      )
    }

    // Install (or replace) the shared trigger function once per connection
    try {
      await client.query(createTriggerFunctionSQL(this.schema, this.prefix))
    } catch (err) {
      await client.end().catch(() => undefined)
      throw new ReactiveApiError(
        'POSTGRES_TRIGGER_FUNCTION_FAILED',
        `Failed to install trigger function: ${errorMessage(err)}`,
      )
    }

    // Start listening on the shared channel
    const channel = notifyChannel(this.prefix)
    await client.query(`LISTEN "${channel}"`)

    client.on('notification', (msg) => {
      if (msg.channel !== channel || !msg.payload) return
      this.handleNotification(msg.payload)
    })

    client.on('error', (err) => {
      // Log but don't crash — the adapter becomes unavailable; the app can
      // call disconnect() + connect() to recover.
      console.error('[RouteFlow/postgres] LISTEN client error:', err.message)
    })

    this.listenClient = client
  }

  /** Disconnect the LISTEN client and optionally clean up triggers. */
  async disconnect(): Promise<void> {
    if (!this.listenClient) return

    const client = this.listenClient
    this.listenClient = null

    // Remove all installed table triggers and the shared function
    for (const table of this.installedTriggers) {
      await client
        .query(dropTableTriggerSQL(this.schema, this.prefix, table))
        .catch(() => undefined)
    }
    this.installedTriggers.clear()

    await client
      .query(dropTriggerFunctionSQL(this.schema, this.prefix))
      .catch(() => undefined)

    await client.end().catch(() => undefined)
    this.listeners.clear()
  }

  /**
   * Register a callback for changes on `table`.
   * Installs a PostgreSQL trigger on first registration for this table.
   *
   * @returns An unsubscribe function.
   */
  onChange(table: string, callback: (event: ChangeEvent) => void): () => void {
    if (!this.listeners.has(table)) {
      this.listeners.set(table, new Set())
    }
    this.listeners.get(table)!.add(callback)

    // Install trigger asynchronously; errors are surfaced to the console
    // rather than throwing so registration can happen before connect().
    this.ensureTriggerInstalled(table).catch((err) => {
      console.error(
        `[RouteFlow/postgres] Failed to install trigger for table "${table}":`,
        errorMessage(err),
      )
    })

    return () => {
      this.listeners.get(table)?.delete(callback)
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async ensureTriggerInstalled(table: string): Promise<void> {
    if (this.installedTriggers.has(table)) return
    if (!this.listenClient) return // will be retried via connect() flow

    try {
      await this.listenClient.query(
        createTableTriggerSQL(this.schema, this.prefix, table),
      )
      this.installedTriggers.add(table)
    } catch (err) {
      if (err instanceof DatabaseError) {
        throw new ReactiveApiError(
          'POSTGRES_TRIGGER_INSTALL_FAILED',
          `Failed to install trigger on "${table}": ${err.message}`,
        )
      }
      throw err
    }
  }

  private handleNotification(rawPayload: string): void {
    let payload: unknown
    try {
      payload = JSON.parse(rawPayload)
    } catch {
      console.error('[RouteFlow/postgres] Malformed NOTIFY payload:', rawPayload)
      return
    }

    if (!isNotifyPayload(payload)) {
      console.error('[RouteFlow/postgres] Unexpected payload shape:', payload)
      return
    }

    const event: ChangeEvent = {
      table: payload.table,
      operation: payload.operation,
      newRow: payload.new_row,
      oldRow: payload.old_row,
      timestamp: Date.now(),
    }

    const callbacks = this.listeners.get(payload.table)
    if (!callbacks) return

    for (const cb of callbacks) {
      try {
        cb(event)
      } catch (err) {
        console.error(
          `[RouteFlow/postgres] Listener error on table "${payload.table}":`,
          errorMessage(err),
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Type guards / utilities
// ---------------------------------------------------------------------------

function isNotifyPayload(value: unknown): value is NotifyPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['table'] === 'string' &&
    (v['operation'] === 'INSERT' || v['operation'] === 'UPDATE' || v['operation'] === 'DELETE')
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
