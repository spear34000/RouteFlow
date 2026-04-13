import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * A generic record type for SQLite rows.
 * Keys map to column names; values are SQLite-compatible primitives.
 */
export type SqliteRow = Record<string, string | number | null>

/**
 * File-based key-value store backed by Node's built-in `node:sqlite`.
 * Requires Node.js 22.5+.
 *
 * Data survives server restarts because it is written to a file on disk.
 * The path can be set directly in code — no environment variable required.
 *
 * @example
 * ```ts
 * const store = new SQLiteStore('./data/app.db')
 * store.exec(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)`)
 * store.prepare('INSERT INTO items (name) VALUES (?)').run('Apple')
 * const rows = store.prepare('SELECT * FROM items').all()
 * ```
 */
export class SQLiteStore {
  readonly db: DatabaseSync
  readonly path: string

  /**
   * @param dbPath - Path to the SQLite file. Parent directories are created automatically.
   *                 Relative paths are resolved from `process.cwd()`.
   */
  constructor(dbPath: string) {
    if (typeof dbPath !== 'string' || dbPath.trim() === '') {
      throw new Error('[RouteFlow] SQLiteStore: dbPath must be a non-empty string.')
    }
    // Null-byte injection guard — a path containing \x00 would be silently
    // truncated by the OS and could open a different file than intended.
    if (dbPath.includes('\x00')) {
      throw new Error('[RouteFlow] SQLiteStore: dbPath must not contain null bytes.')
    }
    this.path = resolve(dbPath)
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new DatabaseSync(this.path)
  }

  /** Execute one or more SQL statements (no return value). */
  exec(sql: string): void {
    this.db.exec(sql)
  }

  /** Prepare a statement for repeated use. */
  prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
    return this.db.prepare(sql)
  }

  /** Close the database connection. */
  close(): void {
    this.db.close()
  }
}
