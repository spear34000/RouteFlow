import type { ChangeEvent, DatabaseAdapter, TableStore } from '../types.js'
import { SQLiteStore } from './sqlite-store.js'

/**
 * Validates that a SQLite identifier (table name, column name) contains only
 * safe characters, preventing SQL injection via identifier interpolation.
 *
 * Allowed: letters, digits, underscore. Must start with letter or underscore.
 * Max 63 chars (consistent with PostgreSQL and a reasonable SQLite limit).
 */
function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new Error(
      `[RouteFlow] Unsafe SQL identifier for ${label}: "${value}". ` +
        'Identifiers must start with a letter or underscore and contain only letters, digits, or underscores (max 63 chars).',
    )
  }
}

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

export interface ListOptions<S extends SchemaDefinition> {
  /** Filter rows by exact column value matches. */
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

  // ── Low-level helpers ─────────────────────────────────────────────────────

  // Single escape hatch for node:sqlite's untyped spread API.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sql(stmt: ReturnType<SQLiteStore['prepare']>): any {
    return stmt
  }

  private run(query: string, params: unknown[]): { lastInsertRowid: number; changes: number } {
    return this.sql(this.db.prepare(query)).run(...params)
  }

  private getOne(query: string, params: unknown[]): Record<string, unknown> | undefined {
    return this.sql(this.db.prepare(query)).get(...params)
  }

  private getAll(query: string, params: unknown[]): Record<string, unknown>[] {
    return this.sql(this.db.prepare(query)).all(...params)
  }

  // ── Schema bootstrap ──────────────────────────────────────────────────────

  private createTable(): void {
    const validTypes: ReadonlySet<ColumnType> = new Set(['integer', 'text', 'real', 'json'])

    // Validate table name and all column names against safe SQL identifier rules.
    // Double-quoting alone is not enough — a name containing `"` would break the quote.
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
    const cols = Object.entries(this.schema)
      .map(([col, type]) => `"${col}" ${type === 'json' ? 'TEXT' : type.toUpperCase()}`)
      .join(', ')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS "${this.tableName}" (id INTEGER PRIMARY KEY AUTOINCREMENT, ${cols})`,
    )
  }

  // ── Serialization ─────────────────────────────────────────────────────────

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

    // ── Input validation ────────────────────────────────────────────────────
    const validColumns = new Set<string>(['id', ...Object.keys(this.schema)])
    const orderByStr = String(orderBy)
    if (!validColumns.has(orderByStr)) {
      throw new Error(`Invalid orderBy column "${orderByStr}"`)
    }
    if (order !== 'asc' && order !== 'desc') {
      throw new Error(`Invalid order direction "${order as string}"`)
    }
    if (limit != null) {
      if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) {
        throw new Error(`Invalid limit "${limit}" — must be a non-negative integer ≤ 10 000`)
      }
    }

    const params: unknown[] = []
    const whereParts: string[] = []

    if (where) {
      for (const [k, v] of Object.entries(where)) {
        // Whitelist column names to prevent injection via where keys
        if (!validColumns.has(k)) throw new Error(`Invalid where column "${k}"`)
        whereParts.push(`"${k}" = ?`)
        params.push(this.jsonCols.has(k) ? JSON.stringify(v) : v)
      }
    }

    const clauses = [
      `SELECT * FROM "${this.tableName}"`,
      whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '',
      `ORDER BY "${orderByStr}" ${order}`,
      limit != null ? `LIMIT ${limit}` : '',
    ].filter(Boolean)

    return this.getAll(clauses.join(' '), params).map((r) => this.deserialize(r))
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
    const row = this.getOne(`SELECT * FROM "${this.tableName}" WHERE id = ?`, [id])
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
    // Quote all column names — column keys are schema-validated at construction,
    // but we quote defensively to prevent any future path that bypasses validation.
    const keys = Object.keys(serialized)
    const quotedKeys = keys.map((k) => `"${k}"`)
    const result = this.run(
      `INSERT INTO "${this.tableName}" (${quotedKeys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      Object.values(serialized),
    )
    // Construct from serialized data + new id — avoids a round-trip SELECT.
    const created = this.deserialize({ id: result.lastInsertRowid, ...serialized })
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
    // Quote column names in SET clause — same defensive quoting as create().
    const setClauses = Object.keys(serialized).map((k) => `"${k}" = ?`).join(', ')
    // RETURNING * avoids a second SELECT round-trip.
    const row = this.getOne(
      `UPDATE "${this.tableName}" SET ${setClauses} WHERE id = ? RETURNING *`,
      [...Object.values(serialized), id],
    )
    if (!row) return null

    const updated = this.deserialize(row)
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
    // RETURNING * avoids a prior SELECT round-trip to get the old row.
    const row = this.getOne(`DELETE FROM "${this.tableName}" WHERE id = ? RETURNING *`, [id])
    if (!row) return false

    const old = this.deserialize(row)
    this.emit({ table: this.tableName, operation: 'DELETE', newRow: null, oldRow: old, timestamp: Date.now() })
    return true
  }

  /**
   * Seed the table with initial rows if it is empty.
   * Runs at startup before subscribers attach — does not emit change events.
   *
   * @example
   * ```ts
   * await items.seed([{ name: 'Apple', createdAt: '2026-01-01T00:00:00.000Z' }])
   * ```
   */
  async seed(rows: Omit<InferRow<S>, 'id'>[]): Promise<void> {
    const count = (this.getOne(`SELECT COUNT(*) as n FROM "${this.tableName}"`, []) as { n: number }).n
    if (count > 0 || rows.length === 0) return

    const keys = Object.keys(this.serialize(rows[0] as Record<string, unknown>))
    const sql = `INSERT INTO "${this.tableName}" (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    const stmt = this.db.prepare(sql)
    for (const row of rows) {
      this.sql(stmt).run(...Object.values(this.serialize(row as Record<string, unknown>)))
    }
  }
}

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
 * const db    = new RouteStore('./data/app.db')
 * const items = db.table('items', { name: 'text', createdAt: 'text' })
 *
 * await items.seed([{ name: 'Apple', createdAt: new Date().toISOString() }])
 *
 * const app = createApp({ adapter: db, port: 3000 })
 * ```
 */
export class RouteStore implements DatabaseAdapter {
  private readonly sql: SQLiteStore
  private readonly listeners = new Map<string, Set<(event: ChangeEvent) => void>>()

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
   *   title:    'text',
   *   done:     'integer',  // 0 | 1
   *   metadata: 'json',     // auto-serialised JS object
   * })
   * ```
   */
  table<S extends SchemaDefinition>(name: string, schema: S): RouteTable<S> {
    return new RouteTable(this.sql, name, schema, (evt) => this.dispatchEvent(evt))
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.sql.close()
  }

  onChange(table: string, callback: (event: ChangeEvent) => void): () => void {
    if (!this.listeners.has(table)) this.listeners.set(table, new Set())
    this.listeners.get(table)!.add(callback)
    return () => this.listeners.get(table)?.delete(callback)
  }

  private dispatchEvent(event: ChangeEvent): void {
    const cbs = this.listeners.get(event.table)
    if (!cbs) return
    for (const cb of cbs) cb(event)
  }
}
