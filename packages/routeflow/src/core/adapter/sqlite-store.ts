import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve, isAbsolute } from 'node:path'

function getDatabaseSync(): typeof DatabaseSyncType {
  const sqlite = globalThis.process?.getBuiltinModule?.('node:sqlite') as
    | { DatabaseSync?: typeof DatabaseSyncType }
    | undefined

  if (!sqlite?.DatabaseSync) {
    throw new Error(
      '[RouteFlow] SQLite support requires Node.js 22.13+ and the built-in `node:sqlite` module.',
    )
  }

  return sqlite.DatabaseSync
}

/**
 * A generic record type for SQLite rows.
 * Keys map to column names; values are SQLite-compatible primitives.
 */
export type SqliteRow = Record<string, string | number | null>

/**
 * File-based key-value store backed by Node's built-in `node:sqlite`.
 * Requires Node.js 22.13+.
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
  readonly db: InstanceType<typeof DatabaseSyncType>
  readonly path: string

  /**
   * @param dbPath   - Path to the SQLite file. Parent directories are created automatically.
   *                   Relative paths are resolved from `process.cwd()`.
   *                   **Security**: if `dbPath` is derived from untrusted input (e.g. an
   *                   env variable or HTTP parameter), pass `allowedDir` to restrict where
   *                   the file may be created.
   * @param allowedDir - Optional directory that the resolved `dbPath` must be contained
   *                   within. Throws if the resolved path escapes this directory.
   *                   Example: `new SQLiteStore(userPath, process.cwd() + '/data')`
   */
  constructor(dbPath: string, allowedDir?: string) {
    if (typeof dbPath !== 'string' || dbPath.trim() === '') {
      throw new Error('[RouteFlow] SQLiteStore: dbPath must be a non-empty string.')
    }
    // Null-byte injection guard — a path containing \x00 would be silently
    // truncated by the OS and could open a different file than intended.
    if (dbPath.includes('\x00')) {
      throw new Error('[RouteFlow] SQLiteStore: dbPath must not contain null bytes.')
    }
    this.path = dbPath === ':memory:' ? ':memory:' : resolve(dbPath)
    // Directory traversal guard — when allowedDir is provided, ensure the
    // resolved path stays within that directory.
    if (allowedDir) {
      const safeDir = resolve(allowedDir)
      if (!this.path.startsWith(safeDir + (isAbsolute(safeDir) ? '/' : ''))) {
        throw new Error(
          `[RouteFlow] SQLiteStore: dbPath "${this.path}" is outside the allowed directory "${safeDir}".`,
        )
      }
    }
    // ':memory:' is an in-memory database — no directory to create.
    if (this.path !== ':memory:') {
      mkdirSync(dirname(this.path), { recursive: true })
    }
    const DatabaseSync = getDatabaseSync()
    this.db = new DatabaseSync(this.path)

    // Enable WAL (Write-Ahead Log) mode for better concurrent read performance.
    // WAL allows readers and a single writer to run simultaneously without blocking
    // each other, which is critical for real-time push workloads where reads and
    // writes happen concurrently.
    //
    // SYNCHRONOUS = NORMAL gives a good balance of durability and speed:
    // SQLite syncs at safe checkpoints but not on every transaction.
    if (this.path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    }
  }

  /** Execute one or more SQL statements (no return value). */
  exec(sql: string): void {
    this.db.exec(sql)
  }

  /** Prepare a statement for repeated use. */
  prepare(sql: string): ReturnType<InstanceType<typeof DatabaseSyncType>['prepare']> {
    return this.db.prepare(sql)
  }

  /** Close the database connection. */
  close(): void {
    this.db.close()
  }
}
