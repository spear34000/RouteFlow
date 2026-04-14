export { RouteStore } from './core/adapter/route-store.js'
export type { SchemaDefinition, ColumnType, InferRow, ListOptions } from './core/adapter/route-store.js'

/**
 * `DBIStore` — convenience alias for `RouteStore`.
 *
 * Provides a shorter, more intuitive name when you prefer the `DBI` (Database Interface)
 * naming convention common in many frameworks.
 *
 * ```ts
 * import { DBIStore } from 'routeflow-api/sqlite'
 *
 * const db    = new DBIStore('./data/app.db')
 * const posts = db.table('posts', { title: 'text', content: 'text', author: 'text' })
 * ```
 */
export { RouteStore as DBIStore } from './core/adapter/route-store.js'

// Low-level SQL access (advanced use)
export { SQLiteStore } from './core/adapter/sqlite-store.js'
export type { SqliteRow } from './core/adapter/sqlite-store.js'
