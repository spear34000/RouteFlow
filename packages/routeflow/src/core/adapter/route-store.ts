import type { ChangeEvent, DatabaseAdapter, TableStore } from '../types.js'
import { SQLiteStore } from './sqlite-store.js'

// ────────────────────────────────────────────────────────────────────────────
// Schema definition types
// ────────────────────────────────────────────────────────────────────────────

/** Supported column types for RouteStore tables. */
export type ColumnType = 'integer' | 'text' | 'real' | 'json'

/** Schema definition: maps column names to their types. */
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

// ────────────────────────────────────────────────────────────────────────────
// RouteTable — high-level table API
// ────────────────────────────────────────────────────────────────────────────

export interface ListOptions<S extends SchemaDefinition> {
  /** Filter rows by matching column values. */
  where?: Partial<InferRow<S>>
  /** Sort by a column. Defaults to `'id'`. */
  orderBy?: keyof InferRow<S>
  /** Sort direction. Defaults to `'asc'`. */
  order?: 'asc' | 'desc'
  /** Max rows to return. */
  limit?: number
}

/**
 * High-level CRUD interface for a single SQLite table.
 *
 * Created via `RouteStore.table()` — do not instantiate directly.
 */
export class RouteTable<S extends SchemaDefinition> implements TableStore<InferRow<S>> {
  private readonly jsonCols: Set<string>

  constructor(
    private readonly db: SQLiteStore,
    readonly tableName: string,
    private readonly schema: S,
    private readonly emit: (event: ChangeEvent) => void,
  ) {
    this.jsonCols = new Set(
      Object.entries(schema)
        .filter(([, t]) => t === 'json')
        .map(([k]) => k),
    )
    this.createTable()
  }

  // ── Schema bootstrap ──────────────────────────────────────────────────────

  private createTable(): void {
    const cols = Object.entries(this.schema)
      .map(([col, type]) => {
        const sqlType = type === 'json' ? 'TEXT' : type.toUpperCase()
        return `${col} ${sqlType}`
      })
      .join(', ')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS "${this.tableName}" (id INTEGER PRIMARY KEY AUTOINCREMENT, ${cols})`,
    )
  }

  // ── Serialization helpers ─────────────────────────────────────────────────

  private serialize(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data)) {
      out[k] = this.jsonCols.has(k) ? JSON.stringify(v) : v
    }
    return out
  }

  private deserialize(row: Record<string, unknown>): InferRow<S> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      out[k] = this.jsonCols.has(k) && typeof v === 'string' ? JSON.parse(v) : v
    }
    return out as InferRow<S>
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Return all rows, with optional filtering, sorting, and limiting.
   *
   * @example
   * ```ts
   * await items.list()
   * await items.list({ where: { status: 'active' }, orderBy: 'createdAt', order: 'desc', limit: 10 })
   * ```
   */
  async list(options: ListOptions<S> = {}): Promise<InferRow<S>[]> {
    const { where, orderBy = 'id', order = 'asc', limit } = options
    const parts: string[] = []
    const values: unknown[] = []

    if (where) {
      for (const [k, v] of Object.entries(where)) {
        parts.push(`${k} = ?`)
        values.push(this.jsonCols.has(k) ? JSON.stringify(v) : v)
      }
    }

    const whereClause = parts.length ? `WHERE ${parts.join(' AND ')}` : ''
    const orderClause = `ORDER BY ${String(orderBy)} ${order.toUpperCase()}`
    const limitClause = limit != null ? `LIMIT ${limit}` : ''

    const sql = `SELECT * FROM "${this.tableName}" ${whereClause} ${orderClause} ${limitClause}`.trim()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (this.db.prepare(sql) as any).all(...values) as Record<string, unknown>[]
    return rows.map((r) => this.deserialize(r))
  }

  /**
   * Return a single row by `id`, or `null` if not found.
   *
   * @example
   * ```ts
   * const item = await items.get(1)
   * ```
   */
  async get(id: number): Promise<InferRow<S> | null> {
    const row = this.db
      .prepare(`SELECT * FROM "${this.tableName}" WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined
    return row ? this.deserialize(row) : null
  }

  /**
   * Insert a new row and emit an `INSERT` change event.
   *
   * @example
   * ```ts
   * const item = await items.create({ name: 'Apple', createdAt: new Date().toISOString() })
   * ```
   */
  async create(data: Omit<InferRow<S>, 'id'>): Promise<InferRow<S>> {
    const serialized = this.serialize(data as Record<string, unknown>)
    const cols = Object.keys(serialized).join(', ')
    const placeholders = Object.keys(serialized)
      .map(() => '?')
      .join(', ')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (this.db.prepare(`INSERT INTO "${this.tableName}" (${cols}) VALUES (${placeholders})`) as any).run(
      ...Object.values(serialized),
    ) as { lastInsertRowid: number }

    const created = (await this.get(result.lastInsertRowid))!
    this.emit({ table: this.tableName, operation: 'INSERT', newRow: created, oldRow: null, timestamp: Date.now() })
    return created
  }

  /**
   * Update columns on an existing row and emit an `UPDATE` change event.
   * Returns the updated row, or `null` if the `id` does not exist.
   *
   * @example
   * ```ts
   * const updated = await items.update(1, { name: 'Mango' })
   * ```
   */
  async update(id: number, data: Partial<Omit<InferRow<S>, 'id'>>): Promise<InferRow<S> | null> {
    const old = await this.get(id)
    if (!old) return null

    const serialized = this.serialize(data as Record<string, unknown>)
    const setClauses = Object.keys(serialized)
      .map((k) => `${k} = ?`)
      .join(', ')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(this.db.prepare(`UPDATE "${this.tableName}" SET ${setClauses} WHERE id = ?`) as any).run(
      ...Object.values(serialized),
      id,
    )

    const updated = (await this.get(id))!
    this.emit({ table: this.tableName, operation: 'UPDATE', newRow: updated, oldRow: old, timestamp: Date.now() })
    return updated
  }

  /**
   * Delete a row by `id` and emit a `DELETE` change event.
   * Returns `true` if a row was deleted, `false` if `id` was not found.
   *
   * @example
   * ```ts
   * await items.delete(1)
   * ```
   */
  async delete(id: number): Promise<boolean> {
    const old = await this.get(id)
    if (!old) return false

    this.db.prepare(`DELETE FROM "${this.tableName}" WHERE id = ?`).run(id)
    this.emit({ table: this.tableName, operation: 'DELETE', newRow: null, oldRow: old, timestamp: Date.now() })
    return true
  }

  /**
   * Seed the table with initial rows if it is empty.
   *
   * @example
   * ```ts
   * await items.seed([
   *   { name: 'Apple', createdAt: '2026-01-01T00:00:00.000Z' },
   * ])
   * ```
   */
  async seed(rows: Omit<InferRow<S>, 'id'>[]): Promise<void> {
    const count = (
      this.db.prepare(`SELECT COUNT(*) as n FROM "${this.tableName}"`).get() as { n: number }
    ).n
    if (count > 0) return

    // Insert directly without emitting change events —
    // seed runs at startup before any subscribers are attached.
    const cols = Object.keys(rows[0] ?? {}).join(', ')
    const placeholders = Object.keys(rows[0] ?? {}).map(() => '?').join(', ')
    const stmt = this.db.prepare(`INSERT INTO "${this.tableName}" (${cols}) VALUES (${placeholders})`)
    for (const row of rows) {
      const serialized = this.serialize(row as Record<string, unknown>)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(stmt as any).run(...Object.values(serialized))
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// RouteStore — DatabaseAdapter + table factory
// ────────────────────────────────────────────────────────────────────────────

/**
 * File-based SQLite store that implements `DatabaseAdapter`.
 *
 * Use it as the RouteFlow adapter **and** as your data access layer —
 * no separate adapter or manual `emit()` calls required.
 * Any mutation (`create`, `update`, `delete`) automatically fires
 * a `ChangeEvent` and triggers all `@Reactive` WebSocket pushes.
 *
 * Requires Node.js 22.5+ (built-in `node:sqlite`).
 *
 * @example
 * ```ts
 * import { RouteStore } from 'routeflow-api/sqlite'
 * import { createApp }  from 'routeflow-api'
 *
 * const db = new RouteStore('./data/app.db')
 *
 * const items = db.table('items', {
 *   name:      'text',
 *   createdAt: 'text',
 * })
 *
 * await items.seed([{ name: 'Apple', createdAt: new Date().toISOString() }])
 *
 * // db IS the adapter — pass directly to createApp
 * const app = createApp({ adapter: db, port: 3000 })
 * ```
 */
export class RouteStore implements DatabaseAdapter {
  private readonly sql: SQLiteStore
  private readonly listeners = new Map<string, Set<(event: ChangeEvent) => void>>()
  private connected = false

  /**
   * @param dbPath - Path to the SQLite file.
   *                 Parent directories are created automatically.
   *                 Relative paths resolve from `process.cwd()`.
   */
  constructor(dbPath: string) {
    this.sql = new SQLiteStore(dbPath)
  }

  /**
   * Define a table and return a typed CRUD handle.
   * The table is created in SQLite automatically if it does not exist.
   *
   * @param name   - Table name
   * @param schema - Column definitions: `{ columnName: 'integer' | 'text' | 'real' | 'json' }`
   *
   * @example
   * ```ts
   * const tasks = db.table('tasks', {
   *   title:     'text',
   *   done:      'integer',   // 0 | 1
   *   metadata:  'json',      // auto-serialised JS object
   * })
   * ```
   */
  table<S extends SchemaDefinition>(name: string, schema: S): RouteTable<S> {
    return new RouteTable(this.sql, name, schema, (evt) => this.dispatchEvent(evt))
  }

  // ── DatabaseAdapter ───────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.sql.close()
    this.connected = false
  }

  onChange(table: string, callback: (event: ChangeEvent) => void): () => void {
    if (!this.listeners.has(table)) this.listeners.set(table, new Set())
    this.listeners.get(table)!.add(callback)
    return () => this.listeners.get(table)?.delete(callback)
  }

  get isConnected(): boolean {
    return this.connected
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private dispatchEvent(event: ChangeEvent): void {
    const cbs = this.listeners.get(event.table)
    if (!cbs) return
    for (const cb of cbs) cb(event)
  }
}
