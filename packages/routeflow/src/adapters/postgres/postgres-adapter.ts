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
 * ## Change detection
 * - `onChange(table)` installs a per-table `AFTER INSERT|UPDATE|DELETE` trigger
 *   that calls `pg_notify` with a JSON payload (table, operation, new_row, old_row,
 *   event_time).
 * - A single LISTEN connection subscribes to one shared channel for all tables.
 * - Payloads > 7900 bytes are sent without row data (`_truncated: true`);
 *   subscribers receive a `ChangeEvent` with `newRow: null` / `oldRow: null`.
 *   `event_time` is always included even in truncated payloads.
 *
 * ## Pre-connect registration
 * `onChange()` may be called **before** `connect()` (the engine registers listeners
 * at startup, then the app calls `connect()`). Triggers for all pre-registered tables
 * are installed automatically inside `connect()`.
 *
 * ## Auto-reconnect
 * When the LISTEN client disconnects unexpectedly, the adapter reconnects with
 * exponential backoff (configurable via `maxReconnectAttempts` / `reconnectDelayMs`).
 * All active table triggers persist in the database across reconnects; no re-installation
 * is needed.
 *
 * @example
 * ```ts
 * const adapter = new PostgresAdapter({
 *   connectionString: process.env.DATABASE_URL,
 *   onError: (err) => myLogger.error(err),
 * })
 * await adapter.connect()
 * ```
 */
export class PostgresAdapter implements DatabaseAdapter {
  private listenClient: Client | null = null
  private readonly schema: string
  private readonly prefix: string
  private readonly connectionString: string
  private readonly onError?: (error: Error) => void
  private readonly maxReconnectAttempts: number
  private readonly reconnectDelayMs: number
  /** true after disconnect() is called — prevents auto-reconnect */
  private closed = false

  /** table → Set<callback> */
  private readonly listeners: Map<string, Set<(event: ChangeEvent) => void>> = new Map()
  /** Tables for which a trigger has already been installed in the DB */
  private readonly installedTriggers: Set<string> = new Set()

  constructor(options: PostgresAdapterOptions) {
    this.connectionString = options.connectionString
    this.schema = options.schema ?? 'public'
    this.prefix = options.triggerPrefix ?? 'reactive_api'
    this.onError = options.onError
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10
    this.reconnectDelayMs = options.reconnectDelayMs ?? 500
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** True when the LISTEN client is connected. */
  get isConnected(): boolean {
    return this.listenClient !== null
  }

  /** Connect the LISTEN client and install the shared trigger function. */
  async connect(): Promise<void> {
    if (this.listenClient) return
    this.closed = false
    await this.connectCore()
  }

  /** Disconnect the LISTEN client and drop all installed triggers + the trigger function. */
  async disconnect(): Promise<void> {
    this.closed = true
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
   *
   * Safe to call **before** `connect()` — the trigger is installed during
   * `connect()` for any pre-registered table. If called after `connect()`,
   * the trigger is installed immediately (asynchronously).
   *
   * @returns An unsubscribe function.
   */
  onChange(table: string, callback: (event: ChangeEvent) => void): () => void {
    if (!this.listeners.has(table)) {
      this.listeners.set(table, new Set())
    }
    this.listeners.get(table)!.add(callback)

    // If already connected, install the trigger now.
    // If not connected yet, connectCore() will install it on connect.
    if (this.listenClient) {
      this.ensureTriggerInstalled(table).catch((err) => {
        this.emitError(
          new Error(`[RouteFlow/postgres] Failed to install trigger for table "${table}": ${errorMessage(err)}`),
        )
      })
    }

    return () => {
      this.listeners.get(table)?.delete(callback)
    }
  }

  // ---------------------------------------------------------------------------
  // Private — connection lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Core connect implementation — creates a new pg.Client, installs the trigger
   * function, starts listening, and installs triggers for any pre-registered tables.
   */
  private async connectCore(): Promise<void> {
    const client = new Client({ connectionString: this.connectionString })

    try {
      await client.connect()
    } catch (err) {
      throw new ReactiveApiError(
        'POSTGRES_CONNECT_FAILED',
        `Failed to connect to PostgreSQL: ${errorMessage(err)}`,
      )
    }

    // Install (or replace) the shared trigger function
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
      // Log but don't crash — 'end' will follow and trigger reconnect.
      this.emitError(
        new Error(`[RouteFlow/postgres] LISTEN client error: ${err.message}`),
      )
    })

    client.on('end', () => {
      if (this.closed) return
      this.listenClient = null
      void this.scheduleReconnect(0)
    })

    this.listenClient = client

    // ── Bug fix: install triggers for tables registered before connect() ──────
    // ensureTriggerInstalled() returns early when listenClient is null.
    // Now that the client is ready, install any pending tables.
    for (const table of this.listeners.keys()) {
      if (!this.installedTriggers.has(table)) {
        this.ensureTriggerInstalled(table).catch((err) => {
          this.emitError(
            new Error(`[RouteFlow/postgres] Failed to install trigger for table "${table}": ${errorMessage(err)}`),
          )
        })
      }
    }
  }

  /**
   * Reconnect with exponential backoff after an unexpected disconnect.
   * Triggers are DDL — they persist in the DB; no re-installation needed.
   * Only the trigger function (idempotent `CREATE OR REPLACE`) and LISTEN are restored.
   */
  private async scheduleReconnect(attempt: number): Promise<void> {
    if (this.closed) return

    if (attempt >= this.maxReconnectAttempts) {
      this.emitError(
        new Error(
          `[RouteFlow/postgres] Max reconnect attempts (${this.maxReconnectAttempts}) reached — giving up`,
        ),
      )
      return
    }

    // Exponential backoff, capped at 30 s
    const delayMs = Math.min(this.reconnectDelayMs * 2 ** attempt, 30_000)
    await sleep(delayMs)

    if (this.closed) return

    try {
      await this.connectCore()
      // Success — reset: any new listeners added during outage get triggers installed
      // inside connectCore() already.
    } catch (err) {
      this.emitError(
        new Error(
          `[RouteFlow/postgres] Reconnect attempt ${attempt + 1} failed: ${errorMessage(err)}`,
        ),
      )
      void this.scheduleReconnect(attempt + 1)
    }
  }

  // ---------------------------------------------------------------------------
  // Private — trigger management
  // ---------------------------------------------------------------------------

  private async ensureTriggerInstalled(table: string): Promise<void> {
    if (this.installedTriggers.has(table)) return
    if (!this.listenClient) return // will be called again from connectCore()

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

  // ---------------------------------------------------------------------------
  // Private — NOTIFY handling
  // ---------------------------------------------------------------------------

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
      // Use DB-side clock_timestamp() when available — more accurate than Node Date.now()
      // for distributed setups where server clocks may differ.
      timestamp: payload.event_time ?? Date.now(),
    }

    const callbacks = this.listeners.get(payload.table)
    if (!callbacks) return

    for (const cb of callbacks) {
      try {
        cb(event)
      } catch (err) {
        this.emitError(
          new Error(`[RouteFlow/postgres] Listener error on table "${payload.table}": ${errorMessage(err)}`),
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — error emission
  // ---------------------------------------------------------------------------

  private emitError(err: Error): void {
    if (this.onError) {
      try {
        this.onError(err)
      } catch {
        // Never let the error handler crash the adapter
        console.error('[RouteFlow/postgres] onError handler threw:', err.message)
      }
    } else {
      console.error(err.message)
    }
  }
}

// ---------------------------------------------------------------------------
// Type guards / utilities
// ---------------------------------------------------------------------------

function isNotifyPayload(value: unknown): value is NotifyPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v['table'] !== 'string') return false
  if (v['operation'] !== 'INSERT' && v['operation'] !== 'UPDATE' && v['operation'] !== 'DELETE') return false
  // new_row and old_row must be null or a plain object (never array, string, etc.)
  if (v['new_row'] !== null && (typeof v['new_row'] !== 'object' || Array.isArray(v['new_row']))) return false
  if (v['old_row'] !== null && (typeof v['old_row'] !== 'object' || Array.isArray(v['old_row']))) return false
  return true
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
