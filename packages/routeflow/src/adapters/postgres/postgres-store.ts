/**
 * PostgresStore — full CRUD TableStore backed by PostgreSQL.
 *
 * Implements both `DatabaseAdapter` (for reactive push subscriptions via
 * LISTEN/NOTIFY) and the factory for typed `PostgresTable<S>` handles.
 *
 * Usage:
 * ```ts
 * import { postgres } from 'routeflow-api'
 *
 * const pg = postgres(process.env.DATABASE_URL!)
 *
 * const users = pg.table('users', { username: 'text', email: 'text' })
 * const messages = pg.table('messages', { roomId: 'integer', content: 'text' })
 * ```
 */

import type { ChangeEvent, DatabaseAdapter, TableStore } from '../../core/types.js'
import { ADAPTER_SYMBOL } from '../../core/types.js'
import { assertSafeIdentifier } from './trigger-sql.js'
import { PostgresAdapter } from './postgres-adapter.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ColumnType = 'integer' | 'text' | 'real' | 'json'
export type SchemaDefinition = Record<string, ColumnType>

/** TypeScript row type inferred from a schema definition. */
export type InferRow<S extends SchemaDefinition> = {
  id: number
} & {
  [K in keyof S]: S[K] extends 'integer'
    ? number
    : S[K] extends 'real'
      ? number
      : S[K] extends 'json'
        ? unknown
        : string
}

export interface PostgresStoreOptions {
  connectionString: string
  /** PostgreSQL schema. Defaults to 'public'. */
  schema?: string
  /** Prefix for trigger names. Defaults to 'reactive_api'. */
  triggerPrefix?: string
  /** Called when a DB error or reconnect failure occurs. */
  onError?: (error: Error) => void
  /** Max reconnect attempts for the LISTEN connection. Defaults to 10. */
  maxReconnectAttempts?: number
  /** Initial reconnect delay in ms (exponential backoff). Defaults to 500. */
  reconnectDelayMs?: number
}

// ── pg lazy import ────────────────────────────────────────────────────────────

// pg is a peer dependency — lazy-import to keep the module tree clean.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pgModule: any = null

async function getPool(connectionString: string): Promise<any> {
  if (!pgModule) {
    pgModule = await import('pg')
  }
  const Pool = pgModule.Pool ?? pgModule.default?.Pool
  return new Pool({ connectionString })
}

// ── PostgresTable ─────────────────────────────────────────────────────────────

/**
 * Typed CRUD handle for a single PostgreSQL table.
 * Created via `PostgresStore.table()` — do not instantiate directly.
 */
export class PostgresTable<S extends SchemaDefinition>
  implements TableStore<InferRow<S>>
{
  /** Back-reference to the parent store — used by flow() for auto-discovery. */
  readonly [ADAPTER_SYMBOL]: PostgresStore

  private readonly jsonCols: Set<string>

  constructor(
    private readonly store: PostgresStore,
    readonly tableName: string,
    private readonly schema: S,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    this[ADAPTER_SYMBOL] = store
    this.jsonCols = new Set(
      Object.entries(schema)
        .filter(([, t]) => t === 'json')
        .map(([k]) => k),
    )
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  /** Quoted, validated identifier. */
  private qi(name: string, label: string): string {
    assertSafeIdentifier(name, label)
    return `"${name}"`
  }

  private get qt(): string {
    return `${this.qi(this.store.schema, 'schema')}.${this.qi(this.tableName, 'table')}`
  }

  /** Deserialize a pg result row — parse JSONB fields if they came back as strings. */
  private deserialize(row: Record<string, unknown>): InferRow<S> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      // pg driver returns JSONB as already-parsed objects in most cases,
      // but TEXT fallback may produce strings — handle both.
      out[k] = this.jsonCols.has(k) && typeof v === 'string' ? JSON.parse(v) : v
    }
    return out as InferRow<S>
  }

  // ── Schema bootstrap (called by PostgresStore.connect()) ──────────────────

  /** CREATE TABLE IF NOT EXISTS — called once during connect(). */
  async ensureTable(): Promise<void> {
    const validTypes: ReadonlySet<ColumnType> = new Set(['integer', 'text', 'real', 'json'])

    assertSafeIdentifier(this.tableName, 'table name')
    for (const [col, type] of Object.entries(this.schema)) {
      assertSafeIdentifier(col, `column name in table "${this.tableName}"`)
      if (!validTypes.has(type as ColumnType)) {
        throw new Error(
          `[RouteFlow] Invalid column type "${type}" for "${col}" in table "${this.tableName}". ` +
            `Must be one of: ${[...validTypes].join(', ')}.`,
        )
      }
    }

    const pgType = (t: ColumnType) => {
      if (t === 'integer') return 'INTEGER'
      if (t === 'real') return 'DOUBLE PRECISION'
      if (t === 'json') return 'JSONB'
      return 'TEXT'
    }

    const cols = Object.entries(this.schema)
      .map(([col, type]) => `${this.qi(col, 'column')} ${pgType(type)}`)
      .join(', ')

    await this.store.query(
      `CREATE TABLE IF NOT EXISTS ${this.qt} (id SERIAL PRIMARY KEY, ${cols})`,
    )
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────────

  async list(options: {
    where?: Partial<InferRow<S>>
    orderBy?: string
    order?: 'asc' | 'desc'
    limit?: number
    offset?: number
    after?: number
  } = {}): Promise<InferRow<S>[]> {
    const { where, orderBy = 'id', order = 'asc', limit, offset, after } = options

    const validColumns = new Set<string>(['id', ...Object.keys(this.schema)])
    const orderByStr = String(orderBy)
    if (!validColumns.has(orderByStr)) throw new Error(`Invalid orderBy column "${orderByStr}"`)
    if (order !== 'asc' && order !== 'desc') throw new Error(`Invalid order direction "${order as string}"`)

    const params: unknown[] = []
    const whereParts: string[] = []

    if (after != null) {
      params.push(after)
      whereParts.push(`"id" > $${params.length}`)
    }

    if (where) {
      for (const [k, v] of Object.entries(where)) {
        if (!validColumns.has(k)) throw new Error(`Invalid where column "${k}"`)
        params.push(v)
        whereParts.push(`${this.qi(k, 'column')} = $${params.length}`)
      }
    }

    const clauses = [
      `SELECT * FROM ${this.qt}`,
      whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '',
      `ORDER BY ${this.qi(orderByStr, 'orderBy')} ${order.toUpperCase()}`,
      limit  != null ? `LIMIT ${Number(limit) | 0}`   : '',
      offset != null ? `OFFSET ${Number(offset) | 0}` : '',
    ].filter(Boolean)

    const { rows } = await this.store.query(clauses.join(' '), params)
    return rows.map((r: Record<string, unknown>) => this.deserialize(r))
  }

  async get(id: number): Promise<InferRow<S> | null> {
    const { rows } = await this.store.query(
      `SELECT * FROM ${this.qt} WHERE id = $1`,
      [id],
    )
    return rows[0] ? this.deserialize(rows[0]) : null
  }

  /**
   * Return multiple rows by id in a single `WHERE id IN (...)` query.
   * Result order matches the input `ids` array; missing rows appear as `null`.
   */
  async getMany(ids: number[]): Promise<(InferRow<S> | null)[]> {
    if (ids.length === 0) return []
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
    const { rows } = await this.store.query(
      `SELECT * FROM ${this.qt} WHERE id IN (${placeholders})`,
      ids,
    )
    const rowMap = new Map(
      rows.map((r) => [(r as { id: number }).id, this.deserialize(r)]),
    )
    return ids.map((id) => rowMap.get(id) ?? null)
  }

  async create(data: Omit<InferRow<S>, 'id'>): Promise<InferRow<S>> {
    const keys = Object.keys(data as Record<string, unknown>)
    if (keys.length === 0) {
      const { rows } = await this.store.query(
        `INSERT INTO ${this.qt} DEFAULT VALUES RETURNING *`,
      )
      const created = this.deserialize(rows[0])
      this.store.dispatchEvent({ table: this.tableName, operation: 'INSERT', newRow: created, oldRow: null, timestamp: Date.now() })
      return created
    }

    const quotedKeys = keys.map((k) => this.qi(k, 'column')).join(', ')
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')
    const values = keys.map((k) => (data as Record<string, unknown>)[k])

    const { rows } = await this.store.query(
      `INSERT INTO ${this.qt} (${quotedKeys}) VALUES (${placeholders}) RETURNING *`,
      values,
    )
    const created = this.deserialize(rows[0])
    this.store.dispatchEvent({ table: this.tableName, operation: 'INSERT', newRow: created, oldRow: null, timestamp: Date.now() })
    return created
  }

  async update(id: number, data: Partial<Omit<InferRow<S>, 'id'>>): Promise<InferRow<S> | null> {
    const keys = Object.keys(data as Record<string, unknown>)
    if (keys.length === 0) return this.get(id)

    // Fetch old row for the UPDATE event
    const old = await this.get(id)
    if (!old) return null

    const setClauses = keys.map((k, i) => `${this.qi(k, 'column')} = $${i + 1}`).join(', ')
    const values = [...keys.map((k) => (data as Record<string, unknown>)[k]), id]

    const { rows } = await this.store.query(
      `UPDATE ${this.qt} SET ${setClauses} WHERE id = $${keys.length + 1} RETURNING *`,
      values,
    )
    if (!rows[0]) return null

    const updated = this.deserialize(rows[0])
    this.store.dispatchEvent({ table: this.tableName, operation: 'UPDATE', newRow: updated, oldRow: old, timestamp: Date.now() })
    return updated
  }

  async delete(id: number): Promise<boolean> {
    const { rows } = await this.store.query(
      `DELETE FROM ${this.qt} WHERE id = $1 RETURNING *`,
      [id],
    )
    if (!rows[0]) return false

    const old = this.deserialize(rows[0])
    this.store.dispatchEvent({ table: this.tableName, operation: 'DELETE', newRow: null, oldRow: old, timestamp: Date.now() })
    return true
  }

  /**
   * Seed the table with initial rows if it is empty.
   * Does NOT emit change events — use this only at startup.
   */
  async seed(rows: Omit<InferRow<S>, 'id'>[]): Promise<void> {
    if (rows.length === 0) return

    const { rows: countRows } = await this.store.query(`SELECT COUNT(*) AS n FROM ${this.qt}`)
    if (Number(countRows[0].n) > 0) return

    const keys = Object.keys(rows[0] as Record<string, unknown>)
    const quotedKeys = keys.map((k) => this.qi(k, 'column')).join(', ')

    for (const row of rows) {
      const values = keys.map((k) => (row as Record<string, unknown>)[k])
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')
      await this.store.query(
        `INSERT INTO ${this.qt} (${quotedKeys}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values,
      )
    }
  }
}

// ── PostgresStore ─────────────────────────────────────────────────────────────

/**
 * PostgreSQL-backed store that implements `DatabaseAdapter`.
 *
 * Use `postgres(url)` from `'routeflow-api'` instead of constructing directly.
 *
 * - Manages a `pg.Pool` for CRUD queries.
 * - Delegates reactive change detection to `PostgresAdapter` (LISTEN/NOTIFY).
 * - Auto-creates tables on `connect()`.
 */
export class PostgresStore implements DatabaseAdapter {
  /** Back-reference to self — lets flow() auto-discover this adapter. */
  readonly [ADAPTER_SYMBOL]: DatabaseAdapter = this

  readonly schema: string
  readonly triggerPrefix: string

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pool: any | null = null
  private readonly opts: PostgresStoreOptions
  private readonly tables = new Map<string, PostgresTable<SchemaDefinition>>()
  private readonly listeners = new Map<string, Set<(event: ChangeEvent) => void>>()
  private adapter: PostgresAdapter | null = null
  private connected = false

  constructor(opts: PostgresStoreOptions | string) {
    this.opts = typeof opts === 'string' ? { connectionString: opts } : opts
    this.schema = this.opts.schema ?? 'public'
    this.triggerPrefix = this.opts.triggerPrefix ?? 'reactive_api'
  }

  // ── Internal query API ────────────────────────────────────────────────────

  /** Execute a parameterized SQL query via the pool. */
  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    if (!this.pool) throw new Error('[RouteFlow] PostgresStore: not connected. Call connect() first.')
    return this.pool.query(sql, params)
  }

  /** Dispatch a ChangeEvent to all listeners for a table. */
  dispatchEvent(event: ChangeEvent): void {
    const cbs = this.listeners.get(event.table)
    if (!cbs) return
    for (const cb of cbs) cb(event)
  }

  // ── Factory ────────────────────────────────────────────────────────────────

  /**
   * Define a table and return a typed CRUD handle.
   * The table is created in PostgreSQL automatically when `connect()` is called.
   *
   * @example
   * ```ts
   * const users = pg.table('users', { username: 'text', email: 'text', password: 'text' })
   * ```
   */
  table<S extends SchemaDefinition>(name: string, schema: S): PostgresTable<S> {
    const t = new PostgresTable(this, name, schema as SchemaDefinition) as unknown as PostgresTable<S>
    this.tables.set(name, t as unknown as PostgresTable<SchemaDefinition>)
    return t
  }

  // ── DatabaseAdapter ────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected) return
    this.pool = await getPool(this.opts.connectionString)

    // Verify connectivity
    await this.pool.query('SELECT 1')

    // Auto-create all registered tables
    for (const t of this.tables.values()) {
      await t.ensureTable()
    }

    // Start LISTEN/NOTIFY adapter for reactive push
    this.adapter = new PostgresAdapter({
      connectionString: this.opts.connectionString,
      schema:           this.schema,
      triggerPrefix:    this.triggerPrefix,
      onError:          this.opts.onError,
      maxReconnectAttempts: this.opts.maxReconnectAttempts,
      reconnectDelayMs:     this.opts.reconnectDelayMs,
    })

    // Bridge LISTEN/NOTIFY events into our local listener map
    for (const tableName of this.tables.keys()) {
      this.adapter.onChange(tableName, (evt) => this.dispatchEvent(evt))
    }

    await this.adapter.connect()
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
    if (this.adapter) {
      await this.adapter.disconnect()
      this.adapter = null
    }
    if (this.pool) {
      await this.pool.end()
      this.pool = null
    }
  }

  onChange(table: string, callback: (event: ChangeEvent) => void): () => void {
    if (!this.listeners.has(table)) this.listeners.set(table, new Set())
    this.listeners.get(table)!.add(callback)
    return () => this.listeners.get(table)?.delete(callback)
  }

  get isConnected(): boolean {
    return this.connected
  }
}
